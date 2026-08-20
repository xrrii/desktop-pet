# P2-11 桌面端官网管理入口方案

最后更新时间：2026-08-20

## 1. 背景

`Managed Service Phase 2` 的桌面侧 `P2-06` 至 `P2-10` 已完成，当前桌面端已经具备：

- 系统浏览器 `PKCE + loopback` 登录。
- `safeStorage` 持久化 Refresh Token。
- 账号脱敏快照、设备同步、退出登录和当前设备撤销。
- Runtime Token Broker、本地 Runtime Session Bridge。
- 过期、时钟偏差、离线退避和并发刷新协调。

`petdock-web` 与 `petdock-cloud` 侧的 `P2-W01` 至 `P2-W04` 也已完成，官网业务路由、Web Session、OAuth Consent、调用边界与安全收口已经冻结。当前下一工作项为桌面端 `P2-11`：在 Electron 中提供“前往官网管理”入口，并在用户返回应用后刷新桌面内展示的脱敏状态。

## 2. 目标

`P2-11` 只完成以下目标：

1. 在桌面端 Managed 设置区提供固定的“前往官网管理”入口。
2. 由 Electron Main 使用系统默认浏览器打开固定的官网业务页。
3. 用户返回应用后，桌面端主动刷新脱敏账号/设备/能力快照。
4. 保持桌面 Token、官网 Cookie、Web Session 和 Runtime Token 彼此隔离。

## 3. 非目标

本阶段明确不做以下内容：

- 不在 Electron 内嵌官网页面，不使用 `BrowserWindow` 承载官网。
- 不把桌面 Access Token、Refresh Token、Runtime Token、PKCE 参数、Cookie 或 Session 回传给浏览器。
- 不在桌面端实现充值、订单、账单、完整用量看板或设备列表详情页。
- 不新增 Cloud、Web、AI 数据面公网契约。
- 不改写现有 OAuth 登录流程、`prompt=login` 语义、`/oauth/resume` 恢复边界或 Web Session 规则。
- 不因为 P2-11 修改 BYOK 基线；官网不可用时，BYOK 仍可独立使用。

## 4. 约束与冻结边界

### 4.1 安全边界

- Desktop 只允许使用系统浏览器打开官网管理地址，不共享 Cookie 或任何桌面 Token。
- Renderer 不得传入任意 URL；正式官网地址必须由 Main 白名单生成。
- 官网 Web Session 与桌面 Refresh Token 完全隔离；桌面不能假设用户在 `account.petdock.site` 完成 OAuth 后，`petdock.site` 一定已登录。
- 官网仍只调用 `/api/v1/web/*`；桌面继续调用桌面 Bearer API。

### 4.2 主机与路由边界

正式环境固定主机：

```text
官网业务主机：https://petdock.site
账号/OAuth 主机：https://account.petdock.site
控制面主机：https://api.petdock.site
```

`P2-11` 只允许打开 `https://petdock.site/account/*` 下的固定业务路由，不允许打开：

- `api.petdock.site`
- `account.petdock.site`
- `ai.petdock.site`
- 任意外部 URL

### 4.3 桌面展示边界

Electron 继续只展示脱敏信息：

- 登录状态
- 账号昵称或邮箱脱敏摘要
- 当前设备名称
- 套餐名称或能力状态
- 额度摘要

充值、订单、账单、完整用量看板和其他设备管理全部跳转官网处理。

## 5. 用户故事

### 5.1 已登录用户

1. 用户在设置页看到 Managed 账号摘要。
2. 用户点击“前往官网管理”。
3. Electron Main 打开系统浏览器进入固定官网业务页。
4. 用户在官网查看套餐、设备或用量。
5. 用户切回桌面应用。
6. 桌面端自动刷新脱敏状态，并更新界面展示。

### 5.2 未登录用户

1. 用户点击“前往官网管理”。
2. 系统浏览器打开固定官网业务页。
3. 官网按既有 Web Session 规则决定是否需要登录。
4. 若用户未登录，则进入官网已有登录流程；登录成功后仅返回白名单业务页。
5. 用户回到桌面应用后，桌面端只刷新桌面自己的脱敏状态，不尝试接管官网 Session。

## 6. 方案概览

### 6.1 入口形态

桌面端在现有 Managed 设置区新增一个主入口按钮：

- 按钮文案：`前往官网管理`
- 默认目标：`overview`

同时预留固定目标枚举，供后续在不改协议的前提下扩展到不同业务页：

```text
overview
plans
devices
usage
billing
```

### 6.2 固定路由白名单

Main 内部维护目标到官网路由的受控映射：

| 目标 | 路由 |
| --- | --- |
| `overview` | `/account/plan` |
| `plans` | `/account/plan` |
| `devices` | `/account/devices` |
| `usage` | `/account/usage` |
| `billing` | `/account/orders` 或后续固定账单页 |

说明：

- 如果当前官网尚未提供某个正式页面，则仍应跳到已存在且稳定的业务页，不创建临时桌面专用页面。
- `billing` 在现阶段可以先落到已存在的订单或充值占位页，但映射必须固定在 Main 白名单中。

### 6.3 返回应用后的刷新

桌面端不依赖浏览器回调，不接收浏览器敏感信息，仅在以下时机执行刷新：

1. 点击“前往官网管理”成功打开浏览器后，记录一次待刷新标记。
2. Electron 主窗口重新获得焦点时，如果存在待刷新标记，则触发一次 Managed 状态刷新。
3. 用户重新打开设置页时，如距离上次刷新超过短时间阈值，可补做一次轻量刷新。

刷新动作分为两步：

1. 拉取最新脱敏账号状态。
2. 触发一次能力/权益摘要刷新。

如果刷新失败：

- 保留当前界面上的旧脱敏快照。
- 显示可恢复的轻量提示，不清除本地有效凭据。
- 不影响 BYOK 使用。

## 7. 模块设计

### 7.1 Main

涉及文件：

- `src/main/index.ts`
- `src/main/managed/managedAuthManager.ts`
- `src/main/managed/managedEndpointPolicy.ts`

新增职责：

1. 定义受控目标类型，例如 `ManagedPortalTarget`。
2. 提供新的 IPC，例如 `managed:open-portal`。
3. 由 Main 根据固定目标枚举组装官网 URL。
4. 调用 `shell.openExternal()` 打开系统浏览器。
5. 在主窗口 `focus` 或 `show` 时机触发返回后的状态刷新。

建议实现：

```text
Renderer -> Preload.openManagedPortal('devices')
Preload -> ipcRenderer.invoke('managed:open-portal', 'devices')
Main -> resolveManagedPortalUrl('devices')
Main -> shell.openExternal('https://petdock.site/account/devices')
Main -> 标记 pendingPortalRefresh = true
Window focus -> 如果 pendingPortalRefresh 为 true，执行 refreshManagedStatus()
```

### 7.2 Preload

涉及文件：

- `src/preload/index.ts`

新增职责：

- 暴露受控 API，例如 `openManagedPortal(target)`。
- 只允许传固定目标枚举，不允许透传 URL 字符串。

约束：

- 继续保持 Renderer 无法直接访问 `shell.openExternal`。
- 继续保持 Renderer 无法获得生产主机地址拼装逻辑。

### 7.3 Renderer

涉及文件：

- `src/renderer/assistant/main.ts`
- Managed 设置区对应模板与样式文件

新增职责：

- 在 Managed 账号区域新增“前往官网管理”按钮。
- 在登录中、未启用或当前状态不允许时，给出稳定禁用态或说明。
- 复用现有 `onManagedAuthStatus` 订阅结果更新界面。

交互建议：

- 已登录时：按钮可直接打开官网。
- 未登录时：按钮仍可用，因为官网可自行要求登录。
- 正在进行桌面登录或退出时：按钮保持可用，但避免与桌面状态按钮共用加载态。

## 8. 受控 URL 设计

建议新增一个仅供 Main 使用的受控解析函数，例如：

```ts
type ManagedPortalTarget = 'overview' | 'plans' | 'devices' | 'usage' | 'billing'
```

函数职责：

1. 固定官网业务主机为 `https://petdock.site`。
2. 将目标枚举映射到白名单业务路由。
3. 禁止拼接查询参数、哈希片段、外部主机和任意返回地址。
4. 对开发环境和生产环境使用同一套路由策略；开发环境只允许通过受控环境配置切换主机，不允许 Renderer 输入任意地址。

建议单独放在 Main 的 `managed` 领域，例如：

```text
src/main/managed/managedPortalRoutes.ts
```

## 9. 刷新策略

### 9.1 刷新来源

优先复用现有能力：

- `managed:get-status`
- `managed:refresh-features`
- `managed:status-changed`

若现有 `managedAuthManager` 已具备聚合刷新入口，则直接复用；若没有，则在 Main 内部补一个“返回官网后刷新”的编排方法，但不新增 Renderer 可见的敏感返回值。

### 9.2 去抖与幂等

为避免频繁切换窗口导致重复请求，建议增加以下保护：

- 同一轮“打开官网管理”只消费一次返回刷新。
- 焦点恢复后的自动刷新增加 `single-flight` 保护。
- 刷新中的重复焦点事件直接忽略。
- 失败后不立即重试风暴，交由用户后续显式刷新或再次打开设置页触发。

### 9.3 刷新后更新

刷新成功后更新：

- Managed 登录状态
- 账号脱敏信息
- 当前设备信息
- 能力或权益摘要
- 需要重新授权、设备已撤销、离线保留凭据等状态标签

## 10. 异常处理

### 10.1 浏览器打开失败

- 给出稳定错误提示，例如“未能打开系统浏览器，请检查系统默认浏览器配置”。
- 不改变当前桌面会话。
- 不清除任何本地凭据。

### 10.2 官网未登录

- 由官网按既有 Session 规则处理，不由桌面注入登录凭据。
- 登录完成后能否进入目标业务页，由官网白名单返回逻辑负责。

### 10.3 官网离线或网络异常

- 允许打开失败或页面不可达。
- 返回桌面后刷新失败时保留旧脱敏状态。
- BYOK 与本地 Assistant 能力继续可用。

### 10.4 设备被撤销或会话过期

- 返回桌面后刷新若发现设备已撤销或登录过期，则进入既有的“需要重新登录”状态。
- 不新增特殊回调通道，继续复用 P2-08 至 P2-10 的既有恢复逻辑。

## 11. 实施步骤

### 11.1 第一步：Main 侧受控官网路由

- 新增 `ManagedPortalTarget` 类型和受控路由映射。
- 新增 URL 解析函数。
- 为开发环境和生产环境复用统一逻辑。

### 11.2 第二步：IPC 与 Preload

- 新增 `managed:open-portal` IPC。
- 在 Preload 暴露 `openManagedPortal()`。
- 校验 Renderer 输入必须为固定枚举值。

### 11.3 第三步：Renderer 按钮与状态

- 在 Managed 设置区新增“前往官网管理”按钮。
- 接入按钮点击逻辑和错误提示。
- 根据当前账号状态补充文案说明。

### 11.4 第四步：返回应用刷新

- 在 Main 中引入待刷新标记。
- 在窗口聚焦时执行一次受控刷新。
- 增加请求去抖、单飞和失败保护。

### 11.5 第五步：文档与回归

- 更新 `docs/roadmap/MANAGED_SERVICE_PROGRESS.md`。
- 记录验证结论、未运行项与风险。

## 12. 测试方案

### 12.1 Main 单元测试

新增或补充以下测试：

- 仅允许固定目标枚举生成官网 URL。
- 禁止任意 URL、查询参数、片段和外部主机。
- 生产模式固定官方官网主机。
- 开发环境覆盖不影响 Renderer 输入边界。

### 12.2 IPC / Preload 测试

- `openManagedPortal()` 只能接受固定目标枚举。
- Renderer 无法直接传入完整 URL。

### 12.3 Renderer 测试

- 已登录、未登录、离线、会话过期等状态下按钮展示正确。
- 点击按钮时调用受控 API。
- 浏览器打开失败时显示稳定提示。

### 12.4 集成回归

最小回归覆盖：

1. 已登录用户点击“前往官网管理”可打开系统浏览器。
2. 未登录用户点击后进入官网既有登录流程。
3. 用户返回应用后，桌面端自动刷新一次脱敏状态。
4. 官网完成设备撤销后，桌面端返回刷新可见状态变化。
5. 官网不可达时，桌面端不丢失本地凭据，BYOK 不受影响。

### 12.5 打包版验收

- Windows 解包版或安装包环境下验证系统浏览器打开。
- 验证 Renderer、日志、截图和错误信息中均不暴露 Token、Cookie、PKCE 参数或完整回调地址。

## 13. 验收标准

- 桌面端提供稳定的“前往官网管理”入口。
- 系统浏览器只能打开固定白名单官网业务页。
- Renderer 无法传入任意 URL。
- 用户返回应用后可自动刷新脱敏状态。
- 官网 Session 与桌面 Token 继续完全隔离。
- 官网不可用时，BYOK 和本地助手能力不受影响。
- 不新增 Cloud/Web/AI 数据面契约变更。

## 14. 风险与回退

### 14.1 风险

- 不同系统浏览器的窗口切回行为不同，可能导致焦点恢复时机不稳定。
- 官网业务页若后续调整路径，需要同步更新 Main 白名单映射。
- 如果返回刷新过于频繁，可能造成不必要的控制面请求。

### 14.2 回退

- 若发现入口体验或刷新逻辑不稳定，可仅关闭桌面端“前往官网管理”入口，不影响已有登录、会话恢复、BYOK 和 Runtime Token 能力。
- 回退不涉及数据库迁移、契约回滚或 Token 存储结构调整。

## 15. 预期改动文件

建议改动文件如下：

```text
src/main/index.ts
src/main/managed/managedPortalRoutes.ts      # 新增
src/preload/index.ts
src/renderer/assistant/main.ts
docs/roadmap/MANAGED_SERVICE_PROGRESS.md
```

如需增加测试，建议同步补充：

```text
src/main/managed/__tests__/managedPortalRoutes.test.ts
src/preload/__tests__/index.test.ts
src/renderer/assistant/__tests__/managed-settings.test.ts
```

## 16. 一句话结论

`P2-11` 的本质不是把官网搬进桌面，而是在保持 Web Session 与桌面 Token 严格隔离的前提下，为桌面提供一个安全、固定、可回刷状态的官网管理跳转入口。
