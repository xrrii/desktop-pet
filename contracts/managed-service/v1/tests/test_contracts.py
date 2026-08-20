from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator, FormatChecker

"""校验 Managed Service v1 契约、样例和已冻结安全边界。"""

CONTRACT_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ROOT = CONTRACT_ROOT / "schemas"
EXAMPLE_ROOT = CONTRACT_ROOT / "examples"
OPENAPI_ROOT = CONTRACT_ROOT / "openapi"

EXAMPLE_SCHEMAS = {
    "capability-settings.json": "capability-settings.schema.json",
    "runtime-token-header.json": "runtime-token-header.schema.json",
    "runtime-token-claims.json": "runtime-token-claims.schema.json",
    "request-context.json": "request-context.schema.json",
    "managed-auth-refresh-event.json": "managed-auth-refresh-event.schema.json",
    "managed-auth-result.json": "managed-auth-result.schema.json",
    "usage-event.json": "usage-event.schema.json",
    "chat-stream-event.json": "chat-stream-event.schema.json",
    "chat-stream-tool-call.json": "chat-stream-event.schema.json",
    "chat-stream-usage.json": "chat-stream-event.schema.json",
    "chat-stream-completed.json": "chat-stream-event.schema.json",
    "chat-stream-error.json": "chat-stream-event.schema.json",
    "web-session-anonymous.json": "web-session-snapshot.schema.json",
    "web-session-authenticated.json": "web-session-snapshot.schema.json",
}


def _read_json(path: Path) -> dict[str, Any]:
    """读取 UTF-8 JSON 对象，避免测试对当前工作目录产生依赖。"""
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict), f"契约文件必须是 JSON 对象: {path}"
    return value


def _read_yaml(path: Path) -> dict[str, Any]:
    """读取 OpenAPI YAML，并要求根节点为对象。"""
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict), f"OpenAPI 文件必须是对象: {path}"
    return value


def _resolve_internal_pointer(document: dict[str, Any], pointer: str) -> object:
    """解析 OpenAPI 内部 JSON Pointer，确保引用目标真实存在。"""
    current: object = document
    for raw_part in pointer.removeprefix("#/").split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        assert isinstance(current, dict) and part in current, f"内部引用不存在: {pointer}"
        current = current[part]
    return current


def _collect_refs(value: object) -> list[str]:
    """递归收集 OpenAPI 中的全部引用。"""
    if isinstance(value, dict):
        references = [value["$ref"]] if isinstance(value.get("$ref"), str) else []
        for item in value.values():
            references.extend(_collect_refs(item))
        return references
    if isinstance(value, list):
        return [reference for item in value for reference in _collect_refs(item)]
    return []


def test_all_json_schemas_are_valid_draft_2020_12() -> None:
    """确保所有独立 Schema 都符合 JSON Schema 2020-12。"""
    schemas = sorted(SCHEMA_ROOT.glob("*.schema.json"))
    assert schemas
    for path in schemas:
        Draft202012Validator.check_schema(_read_json(path))


def test_examples_match_their_schemas() -> None:
    """用同一批固定样例验证跨语言字段名、枚举和格式。"""
    checker = FormatChecker()
    for example_name, schema_name in EXAMPLE_SCHEMAS.items():
        schema = _read_json(SCHEMA_ROOT / schema_name)
        example = _read_json(EXAMPLE_ROOT / example_name)
        Draft202012Validator(schema, format_checker=checker).validate(example)


def test_runtime_token_has_frozen_lifetime_and_no_provider_credentials() -> None:
    """冻结 15 分钟 TTL，并禁止在官方 Runtime Token 中携带上游凭据。"""
    claims = _read_json(EXAMPLE_ROOT / "runtime-token-claims.json")
    assert claims["exp"] - claims["iat"] == 15 * 60
    forbidden = {"api_key", "provider_key", "refresh_token", "authorization"}
    assert forbidden.isdisjoint({key.lower() for key in claims})
    header = _read_json(EXAMPLE_ROOT / "runtime-token-header.json")
    assert header["alg"] == "RS256"
    assert header["typ"] == "JWT"
    assert header["kid"]


def test_capability_source_sets_match_frozen_rules() -> None:
    """防止能力来源在各端实现前再次漂移。"""
    schema = _read_json(SCHEMA_ROOT / "capability-settings.schema.json")
    definitions = schema["$defs"]
    expected = {
        "chat": ({"byok", "managed", "disabled"}, {"byok", "managed", "disabled", "mock"}),
        "embedding": ({"byok", "managed", "local"}, {"byok", "managed", "local"}),
        "vision": ({"byok", "managed", "disabled"}, {"byok", "managed", "disabled"}),
        "rerank": ({"managed", "disabled"}, {"managed", "disabled"}),
        "webSearch": ({"byok", "managed", "disabled"}, {"byok", "managed", "disabled"}),
    }
    for capability, (selected, effective) in expected.items():
        properties = definitions[capability]["allOf"][1]["properties"]
        assert set(properties["selectedSource"]["enum"]) == selected
        assert set(properties["effectiveSource"]["enum"]) == effective


def test_error_catalog_is_unique_and_has_required_codes() -> None:
    """校验错误码唯一、字段完整，并包含认证流式终止错误。"""
    catalog = _read_json(CONTRACT_ROOT / "error-codes" / "error-codes.json")
    errors = catalog["errors"]
    codes = [item["code"] for item in errors]
    assert len(codes) == len(set(codes))
    assert {
        "authentication_required",
        "invalid_credentials",
        "username_unavailable",
        "csrf_invalid",
        "password_policy_violation",
        "current_password_invalid",
        "password_authentication_unavailable",
        "token_expired",
        "device_revoked",
        "device_access_denied",
        "device_not_found",
        "device_conflict",
        "runtime_session_not_found",
        "capability_disabled",
        "capability_not_entitled",
        "quota_exhausted",
        "rate_limited",
        "provider_unavailable",
        "provider_timeout",
        "provider_invalid_response",
        "request_cancelled",
        "request_too_large",
        "unsupported_client_version",
        "authentication_expired_during_stream",
    } <= set(codes)
    for item in errors:
        assert isinstance(item["retryable"], bool)
        assert isinstance(item["message"], str) and item["message"]
        assert item["httpStatus"] is None or 400 <= item["httpStatus"] <= 599


def test_openapi_documents_have_v1_metadata_and_operations() -> None:
    """确保五份 OpenAPI 可解析、版本一致且 operationId 不重复。"""
    operation_ids: list[str] = []
    documents = sorted(OPENAPI_ROOT.glob("*.yaml"))
    assert {path.name for path in documents} == {
        "ai-data-plane.yaml",
        "control-plane.yaml",
        "internal-control-plane.yaml",
        "local-runtime-session.yaml",
        "web-control-plane.yaml",
    }
    for path in documents:
        document = _read_yaml(path)
        assert document["openapi"] == "3.1.0"
        assert document["x-petdock-contract-version"] == 1
        assert isinstance(document.get("paths"), dict) and document["paths"]
        for path_item in document["paths"].values():
            for method, operation in path_item.items():
                if method.lower() not in {"get", "post", "put", "delete", "patch"}:
                    continue
                operation_ids.append(operation["operationId"])
    assert len(operation_ids) == len(set(operation_ids))


def test_openapi_references_exist() -> None:
    """校验内部引用和相对文件引用，避免契约拆分后出现悬空目标。"""
    for path in sorted(OPENAPI_ROOT.glob("*.yaml")):
        document = _read_yaml(path)
        for reference in _collect_refs(document):
            if reference.startswith("#/"):
                _resolve_internal_pointer(document, reference)
                continue
            target_name = reference.split("#", 1)[0]
            target = (path.parent / target_name).resolve()
            assert target.is_file(), f"外部引用不存在: {path.name} -> {reference}"


def test_ai_operations_require_trace_and_idempotency_headers() -> None:
    """除公开健康检查外，AI 调用必须携带完整链路和尝试标识。"""
    document = _read_yaml(OPENAPI_ROOT / "ai-data-plane.yaml")
    required_headers = {
        "#/components/parameters/TraceId",
        "#/components/parameters/RequestId",
        "#/components/parameters/AttemptId",
        "#/components/parameters/ClientVersion",
        "#/components/parameters/DeviceId",
    }
    for path, path_item in document["paths"].items():
        for method, operation in path_item.items():
            if method.lower() not in {"get", "post", "put", "delete", "patch"}:
                continue
            if path == "/ai/v1/health":
                assert operation.get("security") == []
                continue
            references = {
                parameter["$ref"]
                for parameter in operation.get("parameters", [])
                if isinstance(parameter, dict) and "$ref" in parameter
            }
            assert required_headers <= references, f"{method.upper()} {path} 缺少链路 Header"


def test_cloud_web_fetch_endpoint_is_forbidden() -> None:
    """冻结云端只搜索、Electron Main 抓取网页正文的安全边界。"""
    document = _read_yaml(OPENAPI_ROOT / "ai-data-plane.yaml")
    paths = set(document["paths"])
    assert "/ai/v1/web/search" in paths
    assert "/ai/v1/web/fetch" not in paths
    assert not any(path.endswith("/fetch") for path in paths)


def test_local_session_contract_never_returns_access_token() -> None:
    """本地状态接口只能返回脱敏 Session 状态，不能回读 Token。"""
    document = _read_yaml(OPENAPI_ROOT / "local-runtime-session.yaml")
    status_schema = document["components"]["schemas"]["ManagedSessionStatus"]
    assert "accessToken" not in status_schema["properties"]
    update_schema = document["components"]["schemas"]["ManagedSessionUpdate"]
    assert "accessToken" in update_schema["required"]


def test_frozen_public_domains_are_consistent() -> None:
    """确保控制面、数据面、OAuth 和 Token 使用同一组已冻结域名。"""
    control_plane = _read_yaml(OPENAPI_ROOT / "control-plane.yaml")
    ai_data_plane = _read_yaml(OPENAPI_ROOT / "ai-data-plane.yaml")
    web_control_plane = _read_yaml(OPENAPI_ROOT / "web-control-plane.yaml")
    oauth = control_plane["components"]["securitySchemes"]["desktopOAuth"]["flows"]["authorizationCode"]
    claims = _read_json(EXAMPLE_ROOT / "runtime-token-claims.json")
    claims_schema = _read_json(SCHEMA_ROOT / "runtime-token-claims.schema.json")

    assert control_plane["servers"][0]["url"] == "https://api.petdock.site"
    assert ai_data_plane["servers"][0]["url"] == "https://ai.petdock.site"
    assert web_control_plane["servers"][0]["url"] == "https://api.petdock.site"
    assert oauth["authorizationUrl"] == "https://account.petdock.site/oauth2/authorize"
    assert oauth["tokenUrl"] == "https://account.petdock.site/oauth2/token"
    assert claims["iss"] == "https://account.petdock.site"
    assert claims_schema["properties"]["iss"]["const"] == "https://account.petdock.site"


def test_phase_zero_decisions_and_single_host_baseline_are_frozen() -> None:
    """防止已确认决定被重新改回待确认或遗漏单机部署边界。"""
    register = (CONTRACT_ROOT / "DECISION_REGISTER.md").read_text(encoding="utf-8")
    deployment = (CONTRACT_ROOT / "DEPLOYMENT_BASELINE.md").read_text(encoding="utf-8")

    assert "Pending Confirmation" not in register
    for number in range(1, 17):
        assert f"`D-P0-{number:02d}`" in register
    phase_zero_register = register.split("## 4. Phase 2 身份与共享开发决定", 1)[0]
    assert phase_zero_register.count("状态：`Frozen`") == 8
    assert "一台位于中国大陆的云服务器" in deployment
    assert "不建设集群" in deployment
    assert "主机外存储" in deployment


def test_phase_two_identity_decisions_are_frozen() -> None:
    """确保 P2-00 的身份、撤销、端点和共享开发约束不会回退。"""
    register = (CONTRACT_ROOT / "DECISION_REGISTER.md").read_text(encoding="utf-8")
    identity = (CONTRACT_ROOT / "IDENTITY_AND_SESSION.md").read_text(encoding="utf-8")

    for number in range(1, 14):
        assert f"`D-P2-{number:02d}`" in register
    assert "RFC 7009" in identity
    assert "managed_login_enabled" in identity
    assert "Date` Header" in identity
    assert "PostgreSQL 17" in register
    assert "Redis 8.0" in register
    assert "不读取硬件序列号" in register
    assert "不新增客户端设备 Header" in register
    assert "__Host-petdock_web_session" in register
    assert "authorization_consent_enabled" in register


def test_p2_w02_oauth_browser_consent_boundary_is_frozen() -> None:
    """确保 P2-W02 的标准 Consent、双主机 Session 和客户端授权语义不会回退。"""
    register = (CONTRACT_ROOT / "DECISION_REGISTER.md").read_text(encoding="utf-8")
    desktop_oauth = (CONTRACT_ROOT / "DESKTOP_OAUTH.md").read_text(encoding="utf-8")
    web_identity = (CONTRACT_ROOT / "WEB_IDENTITY_AND_SESSION.md").read_text(
        encoding="utf-8"
    )

    for document in (register, desktop_oauth, web_identity):
        assert "requireAuthorizationConsent=true" in document
        assert "不新增 JSON Consent API" in document
        assert "整体同意或整体拒绝" in document
    assert "GET /oauth/resume" in desktop_oauth
    assert "HttpSession RequestCache" in desktop_oauth
    assert "不得接收任意 `returnTo`" in desktop_oauth
    assert "两个独立测试主机名" in desktop_oauth
    assert "不展示或采集尚未建立的具体设备信息" in register
    assert "api.petdock.site" in web_identity
    assert "account.petdock.site" in web_identity
    assert "不共享 `api.petdock.site` 的同名 Cookie" in web_identity


def test_control_plane_feature_flag_contract_is_present() -> None:
    """确保桌面端 Feature Flag 可在登录前读取并使用蛇形字段。"""
    document = _read_yaml(OPENAPI_ROOT / "control-plane.yaml")
    operation = document["paths"]["/api/v1/features"]["get"]
    assert operation["operationId"] == "getFeatureFlags"
    assert operation["security"] == []
    assert "401" not in operation["responses"]
    schema = document["components"]["schemas"]["FeatureFlagSnapshot"]
    assert set(schema["required"]) == {
        "version",
        "managed_login_enabled",
        "minimum_client_version",
    }
    assert schema["properties"]["version"]["const"] == 1


def test_web_control_plane_session_csrf_and_scope_are_frozen() -> None:
    """确保官网契约使用独立 Session/CSRF 边界，并不混用桌面 Bearer API。"""
    document = _read_yaml(OPENAPI_ROOT / "web-control-plane.yaml")
    assert document["x-petdock-contract-version"] == 1
    assert set(document["paths"]) == {
        "/api/v1/web/session",
        "/api/v1/web/auth/register",
        "/api/v1/web/auth/login",
        "/api/v1/web/auth/logout",
        "/api/v1/web/profile",
        "/api/v1/web/account/password",
        "/api/v1/web/entitlements",
        "/api/v1/web/usage/summary",
        "/api/v1/web/devices",
        "/api/v1/web/devices/{deviceId}",
    }
    security_scheme = document["components"]["securitySchemes"]["webSession"]
    assert security_scheme["type"] == "apiKey"
    assert security_scheme["in"] == "cookie"
    assert security_scheme["name"] == "__Host-petdock_web_session"
    assert document["paths"]["/api/v1/web/session"]["get"]["security"] == []
    for path in document["paths"]:
        for method, operation in document["paths"][path].items():
            if method.lower() not in {"get", "post", "put", "patch", "delete"}:
                continue
            references = {
                parameter["$ref"]
                for parameter in operation.get("parameters", [])
                if isinstance(parameter, dict) and "$ref" in parameter
            }
            assert "#/components/parameters/RequestId" in references
            if method.lower() in {"post", "put", "patch", "delete"}:
                assert "#/components/parameters/CsrfToken" in references
    assert "desktopOAuth" not in document["components"]["securitySchemes"]


def test_p2_w03_device_and_billing_modes_are_frozen() -> None:
    """冻结活动设备管理及未开通、套餐、按量三种服务访问状态。"""
    web = _read_yaml(OPENAPI_ROOT / "web-control-plane.yaml")
    desktop = _read_yaml(OPENAPI_ROOT / "control-plane.yaml")
    register = (CONTRACT_ROOT / "DECISION_REGISTER.md").read_text(encoding="utf-8")
    web_identity = (CONTRACT_ROOT / "WEB_IDENTITY_AND_SESSION.md").read_text(
        encoding="utf-8"
    )

    assert web["paths"]["/api/v1/web/entitlements"]["get"]["operationId"] == "getWebEntitlements"
    assert web["paths"]["/api/v1/web/devices"]["get"]["operationId"] == "listWebDevices"
    assert web["paths"]["/api/v1/web/devices"]["delete"]["operationId"] == "revokeAllWebDevices"
    assert web["paths"]["/api/v1/web/devices/{deviceId}"]["delete"]["operationId"] == "revokeWebDevice"
    assert web["components"]["parameters"]["PageSize"]["schema"]["maximum"] == 50
    assert "current" not in web["components"]["schemas"]["WebDevice"]["properties"]

    entitlement = desktop["components"]["schemas"]["EntitlementSnapshot"]
    assert entitlement["oneOf"] == [
        {"$ref": "#/components/schemas/InactiveEntitlementSnapshot"},
        {"$ref": "#/components/schemas/SubscriptionEntitlementSnapshot"},
        {"$ref": "#/components/schemas/PayAsYouGoEntitlementSnapshot"},
    ]
    subscription = desktop["components"]["schemas"]["SubscriptionEntitlementSnapshot"]
    pay_as_you_go = desktop["components"]["schemas"]["PayAsYouGoEntitlementSnapshot"]
    inactive = desktop["components"]["schemas"]["InactiveEntitlementSnapshot"]
    assert subscription["properties"]["billingMode"]["const"] == "subscription"
    assert subscription["properties"]["plan"]["type"] == "string"
    assert subscription["properties"]["capabilities"]["minProperties"] == 1
    assert pay_as_you_go["properties"]["billingMode"]["const"] == "pay_as_you_go"
    assert pay_as_you_go["properties"]["plan"]["type"] == "null"
    assert pay_as_you_go["properties"]["expiresAt"]["type"] == "null"
    assert pay_as_you_go["properties"]["capabilities"]["minProperties"] == 1
    assert inactive["properties"]["status"]["const"] == "inactive"
    assert inactive["properties"]["billingMode"]["type"] == "null"
    assert desktop["components"]["schemas"]["MeteredCapabilityEntitlement"]["properties"]["remaining"]["type"] == "null"
    assert "billingMode" in desktop["components"]["schemas"]["UsageSummary"]["required"]

    inactive_example = _read_json(EXAMPLE_ROOT / "entitlement-inactive.json")
    subscription_example = _read_json(EXAMPLE_ROOT / "entitlement-subscription.json")
    metered_example = _read_json(EXAMPLE_ROOT / "entitlement-pay-as-you-go.json")
    assert inactive_example["status"] == "inactive"
    assert subscription_example["billingMode"] == "subscription"
    assert subscription_example["capabilities"]["chat"]["remaining"] >= 0
    assert metered_example["billingMode"] == "pay_as_you_go"
    assert metered_example["plan"] is None
    assert metered_example["expiresAt"] is None
    assert metered_example["capabilities"]["chat"]["remaining"] is None

    error_catalog = _read_json(CONTRACT_ROOT / "error-codes" / "error-codes.json")
    capability_error = next(
        item for item in error_catalog["errors"] if item["code"] == "capability_not_entitled"
    )
    assert capability_error["message"] == "当前服务方案未授权此能力。"

    for document in (register, web_identity):
        assert "pay_as_you_go" in document
        assert "不表示免费、无限或额度耗尽" in document
    assert "不得未经用户确认自动切换到按量扣费" in register
    assert "当前免费 Beta 只产生套餐模式快照" in register


def test_p3_00_chat_scope_and_feature_flag_are_frozen() -> None:
    """冻结 Phase 3 可公开操作、唯一逻辑模型和兼容 Feature Flag。"""
    ai = _read_yaml(OPENAPI_ROOT / "ai-data-plane.yaml")
    control = _read_yaml(OPENAPI_ROOT / "control-plane.yaml")

    assert ai["x-petdock-phase3-public-operations"] == [
        "POST /ai/v1/chat/completions",
        "GET /ai/v1/capabilities",
        "GET /ai/v1/health",
    ]
    assert ai["paths"]["/ai/v1/chat/completions"]["post"]["x-petdock-availability"] == "phase-3"
    assert ai["paths"]["/ai/v1/capabilities"]["get"]["x-petdock-availability"] == "phase-3"
    assert ai["paths"]["/ai/v1/health"]["get"]["x-petdock-availability"] == "phase-3"
    for path in ("/ai/v1/embeddings", "/ai/v1/vision/analyze", "/ai/v1/rerank", "/ai/v1/web/search"):
        operation = next(iter(ai["paths"][path].values()))
        assert operation["x-petdock-availability"] == "phase-4"

    chat = ai["components"]["schemas"]["ChatRequest"]
    assert chat["properties"]["logicalModel"]["const"] == "chat-standard"
    assert chat["properties"]["stream"]["const"] is True
    assert chat["properties"]["messages"]["maxItems"] == 100
    assert chat["properties"]["tools"]["maxItems"] == 32
    tool = ai["components"]["schemas"]["ToolDefinition"]
    assert tool["additionalProperties"] is False
    assert set(tool["required"]) == {"type", "function"}
    parameters = ai["components"]["schemas"]["ToolParametersSchema"]
    assert set(parameters["required"]) == {"type", "properties", "additionalProperties"}
    assert parameters["properties"]["additionalProperties"]["const"] is False
    assert ai["paths"]["/ai/v1/chat/completions"]["post"]["x-petdock-request-body-max-bytes"] == 1024 * 1024
    assert ai["paths"]["/ai/v1/chat/completions"]["post"]["x-petdock-tool-definition-max-bytes"] == 64 * 1024

    flags = control["components"]["schemas"]["FeatureFlagSnapshot"]
    assert "managed_chat_enabled" in flags["properties"]
    assert flags["properties"]["managed_chat_enabled"]["type"] == "boolean"
    assert "managed_chat_enabled" not in flags["required"]
    example = _read_json(EXAMPLE_ROOT / "feature-flags.json")
    assert example["managed_chat_enabled"] is False


def test_p3_00_internal_usage_protocol_is_frozen() -> None:
    """冻结容器内网预占、终态、指纹和幂等冲突语义。"""
    internal = _read_yaml(OPENAPI_ROOT / "internal-control-plane.yaml")
    assert internal["x-petdock-network-scope"] == "container-internal-only"
    assert set(internal["paths"]) == {
        "/internal/v1/usage/reservations",
        "/internal/v1/usage/reservations/{requestId}/settle",
        "/internal/v1/usage/reservations/{requestId}/release",
        "/internal/v1/usage/reservations/{requestId}/fail",
    }
    assert internal["security"] == [{"serviceBearer": []}]
    reserve_operation = internal["paths"]["/internal/v1/usage/reservations"]["post"]
    assert "已有任一终态" in reserve_operation["description"]
    reserve = internal["components"]["schemas"]["UsageReservationRequest"]
    assert reserve["properties"]["capability"]["const"] == "chat"
    assert reserve["properties"]["logicalModel"]["const"] == "chat-standard"
    assert reserve["properties"]["requestFingerprint"]["pattern"] == "^[a-f0-9]{64}$"
    terminal = internal["components"]["schemas"]["UsageTerminalResponse"]
    assert set(terminal["properties"]["status"]["enum"]) == {"settled", "released", "failed"}
    assert "任何差异" in terminal["description"]
    release = internal["components"]["schemas"]["UsageReleaseRequest"]
    failure = internal["components"]["schemas"]["UsageFailureRequest"]
    assert "provider_not_called" in release["properties"]["reason"]["enum"]
    assert "provider_usage_unknown" in failure["properties"]["reason"]["enum"]

    reservation = _read_json(EXAMPLE_ROOT / "usage-reservation-request.json")
    assert len(reservation["requestFingerprint"]) == 64
    assert reservation["estimatedInputUnits"] >= 0
    assert reservation["maxOutputUnits"] > 0
    result = _read_json(EXAMPLE_ROOT / "usage-reservation-response.json")
    assert result["status"] == "reserved"
    assert result["replayed"] is False


def test_p3_00_sse_usage_and_web_summary_are_frozen() -> None:
    """冻结 SSE 顺序说明、Usage Event 字段和 Web 真实摘要。"""
    stream_schema = _read_json(SCHEMA_ROOT / "chat-stream-event.schema.json")
    rules = stream_schema["x-petdock-stream-rules"]
    assert "严格递增" in rules["sequence"]
    assert "只能有一个" in rules["terminal"]
    assert "终止事件之前" in rules["usage"]
    stream_events = [
        _read_json(EXAMPLE_ROOT / name)
        for name in (
            "chat-stream-event.json",
            "chat-stream-tool-call.json",
            "chat-stream-usage.json",
            "chat-stream-completed.json",
            "chat-stream-error.json",
        )
    ]
    assert [event["type"] for event in stream_events] == ["delta", "tool_call", "usage", "completed", "error"]
    successful_stream = stream_events[:4]
    assert [event["sequence"] for event in successful_stream] == [1, 2, 3, 4]
    assert len({event["traceId"] for event in successful_stream}) == 1
    assert len({event["requestId"] for event in successful_stream}) == 1
    assert successful_stream[-1]["type"] == "completed"
    assert stream_events[-1]["sequence"] == 1
    assert stream_events[-1]["type"] == "error"

    usage_schema = _read_json(SCHEMA_ROOT / "usage-event.schema.json")
    assert {"requestFingerprint", "reservedInputUnits", "reservedOutputUnits", "reason"} <= set(usage_schema["required"])
    usage = _read_json(EXAMPLE_ROOT / "usage-event.json")
    assert usage["status"] == "settled"
    assert usage["reason"] is None
    assert usage["reservedInputUnits"] >= usage["inputUnits"]

    web = _read_yaml(OPENAPI_ROOT / "web-control-plane.yaml")
    operation = web["paths"]["/api/v1/web/usage/summary"]["get"]
    assert operation["operationId"] == "getWebUsageSummary"
    assert operation["security"] == [{"webSession": []}]
    summary = web["components"]["schemas"]["WebUsageSummary"]
    assert summary["properties"]["chat"]["properties"]["unit"]["const"] == "tokens"
    example = _read_json(EXAMPLE_ROOT / "web-usage-summary.json")
    assert example["chat"]["used"] >= 0
    assert example["chat"]["remaining"] >= 0


def test_p3_00_decisions_and_error_codes_are_frozen() -> None:
    """确保 Phase 3 决策和稳定错误码不会在实现前漂移。"""
    register = (CONTRACT_ROOT / "DECISION_REGISTER.md").read_text(encoding="utf-8")
    for number in range(1, 7):
        assert f"`D-P3-{number:02d}`" in register
    assert "RFC 8785" in register
    assert "不存在 -> reserved -> settled|released|failed" in register
    assert "不得暴露到公网 Nginx" in register

    catalog = _read_json(CONTRACT_ROOT / "error-codes" / "error-codes.json")
    codes = {item["code"] for item in catalog["errors"]}
    assert {
        "idempotency_conflict",
        "usage_reservation_not_found",
        "usage_state_conflict",
        "usage_service_unavailable",
        "stream_protocol_error",
    } <= codes
