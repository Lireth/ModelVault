# ModelVault（模匣）

基于 **Electron + Vite + Vue 3** 的 Windows 平台桌面应用模板，开箱即用。

## 技术栈

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Electron | ^44 | 跨平台桌面运行时 |
| electron-vite | ^5 | 构建/开发工具链，内置 HMR 热重载 |
| Vue 3 | ^3.5 | 渲染进程前端框架 |
| electron-builder | ^26 | Windows 打包（NSIS 安装包） |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式（热重载）
npm start
```

## 项目结构

```
ModelVault/
├── build/                        # 打包资源（应用图标 icon.ico 放此处）
├── dist/                         # electron-builder 打包输出（构建后生成）
├── out/                          # electron-vite 编译输出（构建后生成）
├── src/
│   ├── main/                     # 主进程
│   │   ├── index.js              # 应用入口：生命周期、单实例锁、全局错误处理
│   │   ├── windows/
│   │   │   └── mainWindow.js     # 主窗口创建与管理
│   │   ├── menu.js               # 应用菜单与快捷键
│   │   ├── ipc.js                # IPC 处理器注册
│   │   └── logger.js             # 日志模块（控制台 + 文件）
│   ├── preload/
│   │   └── index.js              # 预加载脚本：contextBridge 安全暴露 API
│   └── renderer/                 # 渲染进程（Vue 3）
│       ├── index.html            # HTML 入口（含 CSP）
│       ├── public/               # 静态资源（原样复制）
│       └── src/
│           ├── main.js           # Vue 应用入口
│           ├── App.vue           # 根组件（演示 IPC 通信与窗口控制）
│           └── assets/styles/    # 全局样式
├── electron.vite.config.mjs      # electron-vite 配置
├── electron-builder.yml          # Windows 打包配置
├── .npmrc                        # Electron 二进制国内镜像加速
└── package.json
```

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm start` / `npm run dev` | 启动开发模式（主进程/渲染进程热重载） |
| `npm run build` | 编译主进程、preload、渲染进程到 `out/` |
| `npm run preview` | 以生产构建产物启动应用预览 |
| `npm run dist` | 编译并打包 NSIS 安装包到 `dist/{version}/` |
| `npm run dist:dir` | 编译并生成免安装目录（快速验证打包结果） |

## 开发指南

### 主进程与渲染进程通信

1. 在 `src/main/ipc.js` 中注册处理器：

```js
ipcMain.handle('my:channel', (event, payload) => {
  return 'result'
})
```

2. 在 `src/preload/index.js` 中将通道加入 `VALID_INVOKE_CHANNELS` 白名单。

3. 在渲染进程中调用：

```js
const result = await window.api.invoke('my:channel', payload)
```

### 窗口管理

窗口统一在 `src/main/windows/` 目录管理，可参照 `mainWindow.js` 创建多窗口。

### 应用菜单与快捷键

菜单定义在 `src/main/menu.js`，使用 Electron `accelerator` 语法定义快捷键（如 `CmdOrCtrl+Shift+I`）。

### 日志

- 日志位置：`%APPDATA%\modelvault\logs\modelvault-YYYY-MM-DD.log`（按天分文件）
- 用法：`import logger from './logger'` 后调用 `logger.info / warn / error`
- 全局异常（`uncaughtException` / `unhandledRejection`）自动记录

## 打包说明

- 打包配置见 `electron-builder.yml`（NSIS 安装包，x64，允许自定义安装路径）
- 桌面/开始菜单快捷方式名称为「模匣」
- 如需自定义应用图标，将 `icon.ico`（256×256 及以上）放入 `build/` 目录
- Windows 10 及以上版本可直接运行，无额外运行时依赖

## 安全要点

- `contextIsolation: true` + `nodeIntegration: false`，渲染进程无 Node 能力
- preload 仅暴露白名单通道，防止任意 IPC 调用
- HTML 含 CSP 策略，外部链接通过系统浏览器打开
