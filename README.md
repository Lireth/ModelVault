# ModelVault（模匣）

基于 **Electron + Vite + Vue 3** 的 Windows 平台本地 AI 绘画模型管理软件。

核心功能：

- **模型扫描与自动分类**：选择模型根目录后递归扫描 `.safetensors` / `.ckpt` / `.pt` / `.pth` / `.bin`，按文件夹名与文件名关键词自动分类为 Checkpoint/大模型、TextEncoders/文本编码器、VAE/变分自编码器、LoRA，其余归入「其他模型」，并支持在详情页添加二级分类标签（Embedding / ControlNet / 放大模型 / HyperNetwork / 其他）
- **模型浏览**：卡片式首页，支持按名称搜索、按分类筛选、多种排序，扫描全程异步不阻塞 UI
- **封面管理**：详情页上传封面图片，自动作为首页卡片封面；自动识别模型同名 sidecar 预览图
- **推荐参数**：为每个模型保存采样步数、CFG、采样器、调度器、推荐分辨率区间与备注
- **数据持久化**：模型元数据以 JSON 原子写入用户数据目录，重启不丢失

用户操作说明见 [docs/用户操作手册.md](docs/用户操作手册.md)。

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
├── docs/                         # 文档（用户操作手册）
├── out/                          # electron-vite 编译输出（构建后生成）
├── src/
│   ├── main/                     # 主进程
│   │   ├── index.js              # 应用入口：生命周期、单实例锁、全局错误处理
│   │   ├── windows/
│   │   │   └── mainWindow.js     # 主窗口创建与管理
│   │   ├── menu.js               # 应用菜单与快捷键
│   │   ├── ipc.js                # IPC 处理器注册入口
│   │   ├── ipc/
│   │   │   └── models.js         # 模型管理 IPC 处理器
│   │   ├── protocol.js           # mvimg:// 自定义图片协议
│   │   ├── logger.js             # 日志模块（控制台 + 文件）
│   │   └── services/
│   │       ├── scanner.js        # 模型扫描与自动分类
│   │       ├── store.js          # JSON 持久化（原子写入 + 防抖）
│   │       └── covers.js         # 封面图片选择与保存
│   ├── preload/
│   │   └── index.js              # 预加载脚本：contextBridge 安全暴露 API
│   └── renderer/                 # 渲染进程（Vue 3）
│       ├── index.html            # HTML 入口（含 CSP）
│       ├── public/               # 静态资源（原样复制）
│       └── src/
│           ├── main.js           # Vue 应用入口
│           ├── App.vue           # 根组件（整体布局与空状态）
│           ├── store/
│           │   └── appStore.js   # 全局响应式状态仓库
│           ├── components/
│           │   ├── TopBar.vue        # 顶栏：搜索 / 扫描 / 选文件夹 / 窗口控制
│           │   ├── Sidebar.vue       # 侧栏：分类筛选与排序
│           │   ├── ModelCard.vue     # 模型卡片（封面、类型、参数摘要）
│           │   ├── ModelDetail.vue   # 详情弹层：封面上传 + 推荐参数表单
│           │   └── ToastHost.vue     # 轻提示通知
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

### 快捷键

应用不显示原生菜单栏，快捷键在 `src/main/menu.js` 中通过 `before-input-event`
在窗口级别注册：`Ctrl+Shift+I` 开发者工具、`Ctrl+R` 重新加载、`Ctrl+Shift+R`
强制刷新、`F11` 全屏。

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
