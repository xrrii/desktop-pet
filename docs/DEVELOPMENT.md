# Desktop Pets Electron 开发文档

## 1. 项目目标

基于 Electron 开发一个独立桌宠应用，首个角色使用现有 `hammer-dude` 素材：

- 桌宠名称：雷锤小人
- 素材：`spritesheet.webp`
- 素材尺寸：`1536 x 1872`
- 单帧尺寸：`192 x 208`
- 布局：`8` 列 x `9` 行
- 运行目标：Windows 优先，后续可扩展 macOS / Linux

第一版目标不是做复杂宠物系统，而是先把“透明桌面窗口 + 帧动画 + 拖拽 + 托盘控制 + 打包安装”跑通。

## 2. 技术选型

推荐使用 Electron。

原因：

- 对透明无边框窗口支持成熟。
- 能方便实现窗口置顶、拖拽、托盘菜单、右键菜单、开机启动。
- 用 HTML / CSS / Canvas 播放 spritesheet 很直接。
- 后续做设置面板、角色管理、动作编辑器也容易。

建议技术栈：

- Electron：桌面容器。
- TypeScript：主进程、预加载脚本、渲染层统一类型。
- Vite：渲染层开发服务器和构建。
- Canvas：播放 `spritesheet.webp`，精确控制帧裁切。
- electron-builder：Windows 安装包打包。

可选 UI：

- 设置页可以后续使用 React / Vue。
- 桌宠主体不需要框架，Canvas + 原生 DOM 更轻。

## 3. 项目目录结构

建议在 `E:\project\desktop-pets` 使用如下结构：

```text
desktop-pets/
  package.json
  electron.vite.config.ts
  tsconfig.json
  docs/
    DEVELOPMENT.md
  assets/
    pets/
      hammer-dude/
        pet.json
        spritesheet.webp
  src/
    main/
      index.ts
      tray.ts
      window.ts
      store.ts
    preload/
      index.ts
    renderer/
      index.html
      main.ts
      styles.css
      pet/
        animation.ts
        petManifest.ts
        stateMachine.ts
        drag.ts
```

职责划分：

- `src/main`：Electron 主进程，负责窗口、托盘、系统能力。
- `src/preload`：暴露安全 IPC API。
- `src/renderer`：桌宠画面和交互。
- `assets/pets`：角色资源，可以后续扩展多个宠物。
- `docs`：开发说明和后续设计记录。

## 4. 宠物素材协议

`pet.json` 建议扩展成应用自己的 manifest：

```json
{
  "id": "hammer-dude",
  "displayName": "雷锤小人",
  "description": "A chibi cartoon desktop pet holding a Thor-like hammer.",
  "spritesheetPath": "spritesheet.webp",
  "atlas": {
    "columns": 8,
    "rows": 9,
    "cellWidth": 192,
    "cellHeight": 208,
    "width": 1536,
    "height": 1872
  },
  "states": {
    "idle": { "row": 0, "frames": 6, "fps": 6 },
    "runningRight": { "row": 1, "frames": 8, "fps": 10 },
    "runningLeft": { "row": 2, "frames": 8, "fps": 10 },
    "waving": { "row": 3, "frames": 4, "fps": 6 },
    "jumping": { "row": 4, "frames": 5, "fps": 8 },
    "failed": { "row": 5, "frames": 8, "fps": 6 },
    "waiting": { "row": 6, "frames": 6, "fps": 5 },
    "running": { "row": 7, "frames": 6, "fps": 7 },
    "review": { "row": 8, "frames": 6, "fps": 6 }
  }
}
```

渲染时按如下方式裁切：

- `sx = frameIndex * cellWidth`
- `sy = row * cellHeight`
- `sw = cellWidth`
- `sh = cellHeight`

Canvas 显示尺寸建议第一版使用 1:1，即 `192 x 208`。后续可支持缩放，例如 1.25x / 1.5x / 2x。

## 5. Electron 窗口设计

桌宠窗口配置建议：

```ts
new BrowserWindow({
  width: 192,
  height: 208,
  frame: false,
  transparent: true,
  resizable: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  hasShadow: false,
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
})
```

窗口行为：

- 默认显示在屏幕右下角。
- 窗口背景完全透明。
- 桌宠区域可拖拽。
- 鼠标右键打开菜单。
- 托盘菜单可控制退出、置顶、动作切换、设置。

第一版不建议默认点击穿透。点击穿透会影响拖拽和菜单，建议做成托盘菜单选项：

- 正常交互模式：可拖拽、可右键。
- 点击穿透模式：鼠标事件穿透到桌面，用快捷键或托盘恢复。

## 6. 动画播放方案

使用 `requestAnimationFrame` 驱动，但按每个状态的 `fps` 控制换帧。

核心数据：

```ts
type PetState =
  | 'idle'
  | 'runningRight'
  | 'runningLeft'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

interface AnimationState {
  row: number
  frames: number
  fps: number
}
```

播放逻辑：

1. 加载 spritesheet。
2. 根据当前状态找到 `row / frames / fps`。
3. 按时间累计切换 `frameIndex`。
4. `drawImage` 裁切对应 cell 到 Canvas。
5. 循环播放。

状态优先级建议：

```text
dragging > jumping > waving > failed > waiting > running > review > idle
```

状态切换建议：

- 默认 `idle`。
- 拖拽窗口时，如果横向移动速度为正，播放 `runningRight`。
- 横向移动速度为负，播放 `runningLeft`。
- 单击桌宠，播放 `waving` 一轮后回到 `idle`。
- 双击桌宠，播放 `jumping` 一轮后回到 `idle`。
- 托盘菜单可强制切换 `waiting / running / review / failed`。

## 7. 拖拽交互

推荐由渲染层监听鼠标事件，并通过 IPC 调主进程移动窗口。

流程：

1. `mousedown` 记录鼠标屏幕坐标和窗口坐标。
2. `mousemove` 计算偏移。
3. 通过 `window.api.moveBy(dx, dy)` 或 `window.api.setPosition(x, y)` 通知主进程。
4. 根据 `dx` 切换 `runningRight / runningLeft`。
5. `mouseup` 回到 `idle`。

注意：

- 不要使用 `-webkit-app-region: drag` 覆盖整个 Canvas，否则精细点击事件不好处理。
- Electron 主进程负责最终 `BrowserWindow.setPosition`。
- 需要做屏幕边界限制，避免宠物被拖出屏幕。

## 8. IPC 设计

预加载脚本只暴露必要 API：

```ts
contextBridge.exposeInMainWorld('desktopPet', {
  moveWindow: (x: number, y: number) => ipcRenderer.invoke('pet:move-window', x, y),
  getWindowPosition: () => ipcRenderer.invoke('pet:get-window-position'),
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke('pet:set-always-on-top', value),
  quit: () => ipcRenderer.invoke('app:quit')
})
```

安全要求：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- 渲染进程不直接访问 Node 文件系统。
- IPC channel 使用固定白名单。

## 9. 托盘和菜单

托盘菜单第一版：

```text
雷锤小人
---
动作
  待机
  挥手
  跳跃
  等待
  工作中
  完成检查
  失败
---
始终置顶 [x]
点击穿透 [ ]
开机启动 [ ]
---
退出
```

右键桌宠菜单可以更轻：

```text
挥手
跳一下
置顶 / 取消置顶
隐藏到托盘
退出
```

## 10. 配置存储

建议用一个简单 JSON 配置文件存储用户偏好：

```json
{
  "petId": "hammer-dude",
  "position": { "x": 1200, "y": 700 },
  "scale": 1,
  "alwaysOnTop": true,
  "clickThrough": false,
  "launchAtStartup": false
}
```

存储位置：

- Windows：`app.getPath('userData')/settings.json`

主进程启动时读取配置，窗口移动后节流保存。

## 11. 第一版开发里程碑

### M1：项目初始化

- 初始化 Electron + Vite + TypeScript。
- 创建透明无边框窗口。
- 加载本地 renderer 页面。

验收：

- 应用启动后显示一个透明窗口。
- DevTools 可在开发模式打开。

### M2：素材接入

- 将 `hammer-dude` 资源放入 `assets/pets/hammer-dude`。
- 编写 manifest 读取逻辑。
- Canvas 播放 `idle` 动画。

验收：

- 桌面显示雷锤小人待机动画。
- 背景透明，无黑底或白底。

### M3：交互动作

- 支持拖拽移动。
- 拖拽时按方向播放左右跑。
- 单击挥手，双击跳跃。

验收：

- 拖动流畅。
- 松手回到 idle。
- 点击动作会播放一轮再回 idle。

### M4：托盘和菜单

- 托盘图标。
- 托盘菜单切换动作。
- 退出应用。
- 置顶开关。

验收：

- 没有任务栏按钮。
- 托盘能控制应用。

### M5：设置和打包

- 保存窗口位置和置顶状态。
- electron-builder 打包 Windows 安装包。
- 生成便携版或安装版。

验收：

- 关闭重开后位置保持。
- 打包后的 exe 可独立运行。

## 12. 打包方案

使用 `electron-builder`。

建议 Windows 配置：

```json
{
  "build": {
    "appId": "com.local.desktopPets",
    "productName": "Desktop Pets",
    "directories": {
      "output": "release"
    },
    "files": [
      "dist/**",
      "dist-electron/**",
      "assets/**",
      "package.json"
    ],
    "win": {
      "target": ["nsis", "portable"]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    }
  }
}
```

## 13. 已知风险和处理

### 透明窗口黑边

可能原因：

- Renderer 背景不是透明。
- Canvas 清屏颜色不透明。
- BrowserWindow 没有启用 `transparent: true`。

处理：

- CSS 设置 `html, body { background: transparent; }`
- Canvas 每帧使用 `clearRect`，不要填充背景。

### 拖拽和点击穿透冲突

处理：

- 第一版默认不启用点击穿透。
- 点击穿透只通过托盘菜单开启。
- 开启后托盘菜单提供关闭入口。

### 高 DPI 缩放模糊

处理：

- Canvas 内部尺寸乘以 `devicePixelRatio`。
- CSS 尺寸保持逻辑大小。
- `imageSmoothingEnabled = true` 或按用户偏好关闭。

### 动作尺寸跳动

素材本身每帧已居中在 `192 x 208` cell 内。播放时不要按透明 bbox 重新裁切，必须固定按 cell 裁切。

## 14. 下一步建议

第一步先创建 Electron 项目骨架，并把 `hammer-dude` 资源复制到 `assets/pets/hammer-dude`。

推荐先实现最小可运行版本：

1. `npm install`
2. `npm run dev`
3. 透明窗口显示 idle 动画
4. 支持拖拽
5. 托盘退出

只要这条链路跑通，后续加动作菜单和打包都很顺。
