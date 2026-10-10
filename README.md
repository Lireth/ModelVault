# ModelVault（模匣）

基于 **Electron + Vite + Vue 3** 的 Windows 平台本地 AI 绘画模型管理软件。

核心功能：

- **模型扫描与自动分类**：选择模型根目录后递归扫描 `.safetensors` / `.ckpt` / `.pt` / `.pth` / `.bin`，按文件夹名与文件名关键词自动分类为 Checkpoint/大模型、TextEncoders/文本编码器、VAE/变分自编码器、LoRA，其余归入「其他模型」；分类标签支持「其他模型」二级分类（Embedding / ControlNet / 放大模型 / HyperNetwork）、LoRA 分类标签（角色 / 风格 / 概念 / 服饰 / 背景 / 姿势 / 工具）与 Checkpoint 基底模型自动标注；扫描支持进度展示与**随时取消**，可配置排除目录与扫描文件类型
- **模型浏览**：卡片式首页，**虚拟滚动**支撑数千模型流畅浏览；支持按名称/备注名/备注/LoRA 触发词/分类标签搜索、按分类与收藏筛选、多种排序；封面自动生成**缩略图缓存**（后台生成不阻塞扫描）
- **封面管理**：详情页上传 / Ctrl+V 粘贴 / 拖拽导入多张预览图，点击缩略图设为首页默认显示，支持删除与孤儿文件自动清理；自动识别模型同名 sidecar 预览图
- **收藏 / 评分**：星标收藏、五星评分、NSFW 标记，即时保存，支持收藏筛选
- **批量管理**：多选模式（卡片勾选 + 全选）批量收藏/评分/NSFW/分类标签/移入回收站，复用既有单模型校验与持久化管线
- **多模型库**：保存多个模型根目录，侧栏一键切换与移除；每个库的元数据/封面相互独立（各自 `.modelvault/`）
- **目录监控**：可选开启「目录变更时自动重扫」：轮询 + 快照比对检测变更（空闲间隔自动退避降噪），3 秒防抖合并广播，变更子树走**局部增量扫描**、列表就地合并；关联存储写入不会误触发
- **模型文件管理**：删除（移入系统回收站并清理关联数据）、打开所在文件夹、复制路径/推荐参数，卡片与详情页均提供原生右键菜单
- **列表导出**：当前筛选结果一键导出 CSV（带 BOM，Excel 直接打开），含备注、推荐参数、收藏/评分等全部标注
- **应用内检查更新**：设置页一键查询 GitHub Releases 最新版本，有更新时提供下载页直达链接
- **推荐参数**：为每个模型保存采样步数、CFG 区间、采样器、调度器、精度、推荐分辨率区间与备注
- **关联存储**：模型的封面、推荐参数、备注等用户数据统一保存在所选模型根目录的 `.modelvault/` 文件夹内，按相对路径关联，随文件夹移动/复制保持关联；不同根目录数据相互独立；库内移动/重命名模型文件后，重扫时按确定性规则**自动重关联**元数据（双向唯一才绑定，宁可不绑也绝不绑错）
- **数据备份**：一键将应用设置与当前模型库的标注（备注/参数/收藏/评分）及封面打包为 zip，可随时恢复到任意模型文件夹（缩略图缓存不纳入；覆盖恢复时旧数据自动留 .bak 并仅保留最新一份）
- **体验细节**：亮/暗主题切换（同步原生标题栏颜色）、卡片尺寸/展示内容配置、窗口尺寸与位置记忆、原生标题栏 + 自定义拖拽区

## 界面展示

**模型浏览**：卡片式首页，左侧分类筛选与计数、顶部搜索与排序，扫描全程异步不阻塞 UI。

![模型浏览主界面](image/Exhibition-1.png)

**模型详情**：上传/粘贴封面图片、编辑推荐参数（采样步数、CFG、采样器、调度器、推荐分辨率区间）与备注。

![模型详情页](image/Exhibition-2.png)

## 技术栈

| 组件             | 版本 | 说明                                   |
| ---------------- | ---- | -------------------------------------- |
| Electron         | ^44  | 跨平台桌面运行时                       |
| electron-vite    | ^5   | 构建/开发工具链，内置 HMR 热重载       |
| Vue 3            | ^3.5 | 渲染进程前端框架                       |
| electron-builder | ^26  | Windows 打包（portable 单文件便携版）  |
| Vite             | ^7   | 底层构建引擎                           |
| vitest           | ^5   | 单元测试（主进程 + 渲染层 store/组件） |

## 目录

- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [常用脚本](#常用脚本)
- [开发指南](#开发指南)
- [打包说明](#打包说明)
- [安全要点](#安全要点)

## 快速开始

环境要求：Windows 10 及以上，Node.js ≥ 22.22.2（`package.json` `engines` 强制要求，jsdom 30 依赖新版 Node）。

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式（热重载）
npm start
```

## 项目结构

```
ModelVault/
├── image/                        # 软件界面截图（README 展示用）
├── .github/workflows/            # CI 质量门禁（ci.yml）+ 标签发布构建（release.yml）
├── scripts/                      # 工具脚本（默认图标生成 / CSP 检查）
├── src/
│   ├── shared/                   # 主/渲染进程共享常量（单一来源，纯数据无依赖）
│   │   ├── model-categories.js   #   分类标签定义（二级分类/LoRA 标签/基底模型）
│   │   ├── model-extensions.js   #   扫描文件扩展名
│   │   ├── defaults.js           #   默认设置
│   │   └── app-enums.js          #   通用枚举
│   ├── main/                     # 主进程
│   │   ├── index.js              # 应用入口：生命周期、单实例锁、全局错误处理
│   │   ├── windows/
│   │   │   └── mainWindow.js     # 主窗口创建/管理（窗口状态记忆、WCO 标题栏）
│   │   ├── menu.js               # 窗口级快捷键（无原生菜单栏模式）
│   │   ├── fatal-error.js        # 致命错误分级处理（错误框/日志/退出）
│   │   ├── quit.js               # 退出前落盘与清理（确定性时限）
│   │   ├── ipc.js                # IPC 处理器注册入口（应用信息/主题/异常上报）
│   │   ├── ipc/
│   │   │   └── models/           # 模型管理 IPC 处理器（按域拆分模块）
│   │   │       ├── index.js      #   注册入口
│   │   │       ├── scan.js       #   扫描（全量/增量、进度推送/取消/防重入）
│   │   │       ├── decorate.js   #   扫描结果装饰（封面/缩略图/元数据/sidecar/safetensors）
│   │   │       ├── covers.js     #   封面链路（上传/粘贴/拖拽/设默认/删除）
│   │   │       ├── meta.js       #   元数据链路（标注保存/快捷标记）
│   │   │       ├── misc.js       #   文件管理/右键菜单/复制参数/CSV 导出
│   │   │       ├── backup.js     #   数据备份与恢复
│   │   │       ├── store.js      #   存储与设置链路（loadStore/chooseFolder/settings:update）
│   │   │       └── model-state.js#   跨模块状态（装饰缓存/缩略图后台任务）
│   │   ├── protocol.js           # mvimg:// 自定义图片协议（路径白名单校验）
│   │   ├── theme.js              # 主题颜色常量（主进程共用）
│   │   ├── logger.js             # 日志模块（按天分文件，保留 14 天）
│   │   └── services/
│   │       ├── scanner.js        # 模型扫描与自动分类（支持取消）
│   │       ├── store.js          # 关联存储入口（元数据存于模型根目录 .modelvault/）
│   │       ├── store-meta.js     # 存储元数据域（标注/根目录切换/重关联）
│   │       ├── store-settings.js # 应用设置持久化（含多根目录库列表）
│   │       ├── store-paths.js    # 存储路径计算
│   │       ├── store-events.js   # 存储事件分发
│   │       ├── atomic-write.js   # 原子写入（临时文件 fsync + rename）
│   │       ├── meta-relink.js    # 移动/重命名后的元数据自动重关联规划器
│   │       ├── watcher.js        # 目录监控（轮询快照比对 + 空闲退避 + 防抖广播）
│   │       ├── covers.js         # 封面图片选择/粘贴/拖拽保存与孤儿清理
│   │       ├── thumbs.js         # 封面缩略图缓存（扫描后异步生成）
│   │       ├── backup.js         # 备份打包/恢复（zip）
│   │       ├── updater.js        # 应用内检查更新（GitHub Releases）
│   │       └── safetensors.js    # safetensors 头部解析（kohya/modelspec 训练元信息）
│   ├── preload/
│   │   └── index.js              # 预加载脚本：contextBridge + IPC 通道白名单
│   └── renderer/                 # 渲染进程（Vue 3）
│       ├── index.html            # HTML 入口（含 CSP）
│       └── src/
│           ├── main.js           # Vue 应用入口（全局错误兜底上报）
│           ├── error-report.js   # 渲染进程错误上报链路（四类来源收敛 + 同类节流）
│           ├── App.vue           # 根组件（整体布局、空状态、事件订阅）
│           ├── constants/
│           │   └── modelParams.js# 推荐参数常量（采样器/调度器/精度/取值范围）
│           ├── store/            # 全局响应式状态仓库（按功能域拆分模块）
│           │   ├── appStore.js   #   门面（聚合导出，调用方无感知）
│           │   ├── state.js      #   响应式状态与常量
│           │   ├── filter.js     #   筛选/搜索/排序
│           │   ├── library.js    #   应用初始化/库切换/扫描入口
│           │   ├── model-actions.js # 模型操作（收藏/评分/删除/导出等）
│           │   ├── partial-scan.js  # 局部增量扫描（变更子树就地合并）
│           │   ├── multiselect.js   # 多选批量操作
│           │   ├── meta-apply.js    # 元数据保存与应用
│           │   ├── detail.js        # 详情弹层状态
│           │   ├── covers-store.js  # 封面操作
│           │   ├── selectors.js     # 派生数据（类型统计等）
│           │   ├── format.js        # 展示格式化工具
│           │   └── toast.js         # 轻提示
│           ├── components/
│           │   ├── TopBar.vue            # 标题栏（品牌区 + 原生窗口控件叠加层）
│           │   ├── Sidebar.vue           # 侧栏：库切换/文件夹信息/操作按钮/分类筛选
│           │   ├── VirtualModelGrid.vue  # 虚拟滚动模型网格
│           │   ├── ModelCard.vue         # 模型卡片（封面、类型、收藏、参数摘要）
│           │   ├── ModelDetail.vue       # 详情弹层：封面管理 + 参数表单 + 文件管理
│           │   ├── detail/
│           │   │   ├── CoverPanel.vue    # 详情页封面管理面板
│           │   │   └── AutoInfoPanel.vue # safetensors 自动解析信息面板
│           │   ├── SettingsPage.vue      # 设置页（占据模型预览区）
│           │   └── ToastHost.vue         # 轻提示通知
│           └── assets/styles/    # 全局样式
├── tests/                        # vitest 单元测试（主进程 + 渲染层 store 与组件）
├── electron.vite.config.mjs      # electron-vite 配置
├── electron-builder.yml          # 打包配置（portable 单文件）
└── package.json
```

## 常用脚本

| 命令                        | 说明                                            |
| --------------------------- | ----------------------------------------------- |
| `npm start` / `npm run dev` | 启动开发模式（主进程/渲染进程热重载）           |
| `npm run build`             | 编译主进程、preload、渲染进程到 `out/`          |
| `npm test`                  | 运行单元测试（vitest，`test:watch` 为监视模式） |
| `npm run preview`           | 以生产构建产物启动应用预览                      |
| `npm run dist`              | 编译并打包单文件便携版 EXE 到 `dist/{version}/` |
| `npm run dist:dir`          | 编译并生成免安装目录（快速验证打包结果）        |

## 开发指南

### 主进程与渲染进程通信

渲染进程**没有**裸 `invoke` 入口，所有通道必须经白名单注册：

1. 在 `src/main/ipc.js` 或 `src/main/ipc/models/` 对应域模块中注册处理器：

```js
ipcMain.handle("my:channel", (event, payload) => {
  return "result";
});
```

2. 在 `src/preload/index.js` 中将通道加入 `VALID_INVOKE_CHANNELS` 白名单
   （事件推送类通道加入 `VALID_RECEIVE_CHANNELS`）。

3. 在 `src/preload/index.js` 的 `api` 对象中添加语义化方法
   （内部统一走 `invokeValidated` / `subscribe`）：

```js
const api = {
  myDomain: {
    doThing: (payload) => invokeValidated("my:channel", payload),
    onThing: (listener) => subscribe("my:event", listener)
  }
};
```

4. 渲染进程中通过 `window.api.myDomain.doThing(payload)` 调用。

### 窗口管理

窗口统一在 `src/main/windows/` 目录管理，可参照 `mainWindow.js` 创建多窗口。

### 快捷键

应用不显示原生菜单栏，快捷键在 `src/main/menu.js` 中通过 `before-input-event`
在窗口级别注册：`F11` 全屏切换；`Ctrl+Shift+I` 开发者工具与 `Ctrl+R` /
`Ctrl+Shift+R` 刷新**仅在开发环境生效**，打包发布版不注册。

### 日志

- 日志位置：`%APPDATA%\modelvault\logs\modelvault-YYYY-MM-DD.log`（按天分文件，保留 14 天）
- 用法：`import logger from './logger'` 后调用 `logger.info / warn / error`
- 主进程全局异常（`uncaughtException` / `unhandledRejection`）自动记录；
  渲染进程异常（Vue 错误含上下文、窗口错误、未处理 Promise 拒绝、Vue 警告）
  经 `app:reportError` 通道上报并写入同一日志，同类错误节流降噪

### 测试

单元测试位于 `tests/`：

- **主进程纯逻辑与 IPC handler**：扫描分类、元数据规范化与重关联、原子写入、目录监控（watcher）、备份恢复、协议安全、主题、退出清理等（node 环境）；
- **渲染层 store**：`tests/appStore.test.js` 及按域拆分的模块测试（筛选/排序/批量操作/增量扫描合并等）；
- **渲染层组件交互**：`modelCard` / `topBar` / `sidebar` / `settingsPage` / `modelDetail` / `virtualModelGrid` / `coverPanel` 等组件测试，基于 `@vue/test-utils` + jsdom（文件头 `// @vitest-environment jsdom` 声明 DOM 环境，通用装配见 `tests/helpers/componentTest.js`）。

Electron API 在 `tests/setup.js` 中统一 mock。新增纯函数模块或组件交互时请同步补充用例，运行 `npm test` 验证。

### CI 与发版

- `.github/workflows/ci.yml`：push 到 main / PR 时运行质量门禁（Node 22/24 矩阵：单元测试 → 三端编译 → 产物完整性校验 → 覆盖率归档）
- `.github/workflows/release.yml`：推送 `v*` 标签（版本号须与 `package.json` 一致）触发 Windows 打包，自动创建 GitHub Release 并附加 EXE 与 SHA256 校验和；支持 `workflow_dispatch` 手动构建演练（不发布）

## 打包说明

- 打包配置见 `electron-builder.yml`（portable 单文件便携版，x64），产物为 `dist/{version}/ModelVault-{version}.exe`（版本号随 `package.json` 自动生成）
- 单文件 EXE 运行时不在其所在目录生成任何文件：设置与日志保存在 `%APPDATA%\modelvault\`，模型元数据保存在用户选择的模型文件夹
- 首次启动需解压到系统临时目录，启动速度略慢于常规安装版
- 如需更换应用图标，替换 `build/icon.ico`（256×256 及以上；可运行 `node scripts/generate-icon.mjs` 重新生成默认图标）
- Windows 10 及以上版本可直接运行，无额外运行时依赖

## 安全要点

- `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`，渲染进程无 Node 能力
- preload 仅暴露白名单通道（执行层校验），防止任意 IPC 调用
- `mvimg://` 图片协议仅允许访问当前模型根目录内的文件（路径越界返回 403）
- 渲染进程导航请求一律拦截，外部链接通过系统浏览器打开
- 模型删除移入系统回收站（非永久删除），封面删除有路径越界防护
- 扫描根目录白名单校验（拒绝扫描外部目录）；封面导入有图片魔数校验与大小超限预检
- HTML 含 CSP 策略；开发类快捷键（DevTools/刷新）在生产环境禁用
