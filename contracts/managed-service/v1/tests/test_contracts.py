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
    """确保三份 OpenAPI 可解析、版本一致且 operationId 不重复。"""
    operation_ids: list[str] = []
    documents = sorted(OPENAPI_ROOT.glob("*.yaml"))
    assert {path.name for path in documents} == {
        "ai-data-plane.yaml",
        "control-plane.yaml",
        "local-runtime-session.yaml",
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
    oauth = control_plane["components"]["securitySchemes"]["desktopOAuth"]["flows"]["authorizationCode"]
    claims = _read_json(EXAMPLE_ROOT / "runtime-token-claims.json")
    claims_schema = _read_json(SCHEMA_ROOT / "runtime-token-claims.schema.json")

    assert control_plane["servers"][0]["url"] == "https://api.petdock.site"
    assert ai_data_plane["servers"][0]["url"] == "https://ai.petdock.site"
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

    for number in range(1, 9):
        assert f"`D-P2-{number:02d}`" in register
    assert "`D-P2-09`" in register
    assert "RFC 7009" in identity
    assert "managed_login_enabled" in identity
    assert "Date` Header" in identity
    assert "PostgreSQL 17" in register
    assert "Redis 8.0" in register
    assert "不读取硬件序列号" in register
    assert "不新增客户端设备 Header" in register


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
