# PetDock Managed Service Contract v1

本目录定义 PetDock Managed Service v1 的机器可读契约、固定样例和兼容性规则。仓库对本目录的权威性说明位于上级 `contracts/README.md`，本目录内容在发布源和消费快照之间必须保持逐文件一致。

## 内容

```text
openapi/
  control-plane.yaml               桌面端控制面业务接口
  web-control-plane.yaml            官网 Web Session 与账号接口
  ai-data-plane.yaml               官方 AI 能力接口
  local-runtime-session.yaml       Main 与本地 Runtime 的 Managed Session 接口
schemas/
  capability-settings.schema.json
  web-session-snapshot.schema.json
  runtime-token-header.schema.json
  runtime-token-claims.schema.json
  request-context.schema.json
  managed-auth-refresh-event.schema.json
  managed-auth-result.schema.json
  usage-event.schema.json
error-codes/
  error-codes.json
examples/
  *.json
tests/
  test_contracts.py
COMPATIBILITY.md
DECISION_REGISTER.md
DEPLOYMENT_BASELINE.md
DESKTOP_OAUTH.md
SECURITY_AND_DATA_BOUNDARIES.md
  TOKEN_AND_REVOCATION.md
  IDENTITY_AND_SESSION.md
  WEB_IDENTITY_AND_SESSION.md
```

## 版本规则

- 契约版本为 `v1`，OpenAPI 使用 `x-petdock-contract-version: 1`。
- 同一主版本只允许向后兼容的可选字段、接口或枚举扩展。
- 客户端必须对未知错误码和未知 SSE 事件使用通用降级，不能崩溃。
- 删除字段、收紧已有字段、改变字段语义或改变幂等规则必须发布新的主版本。
- 服务端正式上线后至少兼容当前和上一受支持桌面版本。

## 验证

```powershell
python -m pytest contracts/managed-service/v1/tests
```

验证会检查 OpenAPI 可解析性、Schema 和引用合法性、样例、错误码一致性、禁止的云端 Web Fetch 路由，以及 Runtime Token 的固定安全约束。

Phase 0 和 Phase 2 的产品、身份与基础设施决定统一记录在 `DECISION_REGISTER.md`，桌面身份字段与端点细节见 `IDENTITY_AND_SESSION.md`，桌面 PKCE、loopback、OAuth 浏览器交互与 Authorization Consent 边界见 `DESKTOP_OAUTH.md`，官网 Session、CSRF 与账号字段见 `WEB_IDENTITY_AND_SESSION.md`，单机部署边界见 `DEPLOYMENT_BASELINE.md`。实际 Provider、模型、密钥和可调整额度属于服务端安全配置，不得写入公开契约或客户端。
