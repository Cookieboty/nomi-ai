# 2.0.5 迁移计划：Electron → Go + Wails v3.0.0

> 状态：阶段 0（规划 + 脚手架）。决策日期 2026-10-29（用户拍板）。
> 前置阅读：[arch-go-wails.md](./arch-go-wails.md)（POC 设计与 8.2/8.3 实测）。
> 分支：`feat/2.0.5-go`（基于 `release/2.0.5`），骨架在 `apps/desktop-go/`。

## 0. 决策与约束

- 2.0.5 **直接**从 Electron 迁到 Go + Wails v3.0.0；主进程里所有 Node 代码用 Go 重写，**不带 Node sidecar**。
- 看板娘默认用**静态 SVG**（`rive/nomi-complete/reference/svg-rig/nomi-fullbody-mother.svg`），Rive 动画改为设置里**用户自选开启**。
- 不改任何 Rive / 动画资源（`.riv` 等），不生成角色图。
- Windows / macOS / Linux 三平台都要保留；Mac 用 Developer ID 签名、不公证。
- 渲染进程（React UI）**基本不动**：它已经只经契约客户端（`@nomi-ai/contract` client）说话，`renderer/ai-chat/ui` 里已无 `electronAPI` / `ipcRenderer` 直接调用（grep = 0）。

## 1. 现状盘点（release/2.0.5 @ d511566c）

### 1.1 包与体量（不含测试，TS 行数）

| 包 | 行数 | 角色 | 迁移去向 |
| --- | ---: | --- | --- |
| `core` | ~102.8k | 主进程业务全集（见 1.3） | **Go 重写**（主体） |
| `gateway` | ~29.4k | 统一网关内核：Messages/Responses/Chat/Gemini 四协议请求与流式互转（undici） | Go 重写（`net/http` + SSE） |
| `ai-runtime` | ~10.2k | Vercel AI SDK：`streamText`/`generateText`、`@ai-sdk/mcp` MCP、Provider 管理 | Go 重写（最大风险，见 §4.1） |
| `host-electron` | ~11.4k | 窗口、托盘、岛、截屏、剪贴板、safeStorage、更新、资产协议、TTS 原生 | Go + Wails shell（`wailsshell`） |
| `contract` | ~11.0k | zod 契约（单一真源）、router/server/client/WS 传输 | **保留**；生成 JSON Schema → Go 类型 |
| `ai-sdk` / `ai-sdk-client` / `bundle-*` / `cli-sdk` / `cli-plugins` / `host-node` / `host-ports` | ~16k | 插件宿主、SDK、CLI 适配 | 按依赖拆：契约类型保留，运行时部分 Go 化 |
| `renderer` / `ai-chat` / `ui` / `i18n` / `avatar-runtime` / `character-contract` / `voice` | ~45k | React UI、Rive 运行时、i18n | **保留不变**（仅改 transport 注入与看板娘开关） |

### 1.2 IPC 契约：359 个过程（252 mutation / 102 query / 5 stream）

| 域文件 | 过程数 | 命名空间（过程数） |
| --- | ---: | --- |
| `app/coding.ts` | 100 | harness 63 · cliAccount 11 · cliUpdate 7 · delegate 6 · cli 5 · agents 4 · history 4 |
| `app/knowledge.ts` | 86 | kb 20 · mem 18 · ext 18 · local 16 · sched 13 · hub 1 |
| `app/media.ts` | 80 | desktop 32 · voice 27 · tts 12 · nav 8 · screen 1 |
| `app/shell.ts` | 81 | gateway 21 · usage 15 · quality 9 · onboarding 8 · providers 6 · updates 6 · locale 4 · diagnostics 4 · theme 3 · startup 3 · appIcon 2 |
| `app/mascot.ts` | 54 | mascot 24 · window 13 · chatBg 5 · island 3 · persona 3 · avatar 2 · character 1 |
| `app/ai.ts` | ~50 | `ai.<facade>.<method>`（chat / memory / tools / mcp …） |

（按 `'<ns>.` 前缀统计，和 `kind:` 合计 359 一致到个位；精确清单由批次 1 的生成器输出。）

### 1.3 主进程模块 → Node 依赖 → Go 替代

| 模块（路径） | 规模 | Node / 原生依赖 | Go 替代候选 |
| --- | ---: | --- | --- |
| AI 运行时（ai-runtime: AiSdkLlmProvider、ChatFacade、工具循环） | 10k | `ai`、`@ai-sdk/openai|anthropic|openai-compatible`、zod | `openai/openai-go`、`anthropics/anthropic-sdk-go`，自写 tool loop（或评估 `cloudwego/eino` / `tmc/langchaingo`）；`google/jsonschema-go` |
| MCP（ai-runtime mcpBridge / AiSdkMcpPlugin，`mcp.json`） | — | `@ai-sdk/mcp` createMCPClient（stdio/SSE/HTTP） | `modelcontextprotocol/go-sdk`（官方）或 `mark3labs/mcp-go` |
| 网关（gateway 包 + core/gateway：GatewayProcess/Store/TerminalCommands/worker/windowsTerminal） | 34k | undici、child_process、worker_threads | `net/http`、`httputil.ReverseProxy`、goroutine；SSE 手写 |
| CLI 编排（core/cli：harness Orchestrator/spawn、accounts、SessionHistory、codexThread*、CliUpdate、modelDiscovery） | 17.6k | child_process、worker_threads、`node:sqlite`（只读 OpenCode/Copilot） | `os/exec`、`creack/pty`（Unix）+ ConPTY（`UserExistsError/conpty` 或 `aymanbagabas/go-pty`）；`modernc.org/sqlite`（纯 Go，免 cgo） |
| 用量统计（core/usage：UsageLogScanner、sqliteRead） | 10.2k | fs、`node:sqlite` | `modernc.org/sqlite`、`bufio` 扫 jsonl |
| 桌面工具 / 工作区（core/desktop：DesktopService、PermissionBroker、pathGuard、UndoJournal、AppTrash、AuditLog、parse/extract、reminders） | 4.7k | fs、`unpdf`、`fflate`、`smol-toml`、tesseract.js(OCR) | `os`/`filepath`（含 Win 长短路径归一，参考 d511566c）、`ledongthuc/pdf` 或 `pdfcpu`、`archive/zip`、`BurntSushi/toml` / `pelletier/go-toml/v2`；OCR：保持在渲染进程 WebView 内跑 tesseract.js（WASM），或调用系统 OCR |
| 回收站（AppTrash） | — | fs | 自实现（现状即为应用内回收站） |
| 知识库 / 本地索引（core/knowledge、core/local） | 2.7k | unpdf、onnxruntime-web(嵌入?) | 同上 PDF；嵌入：渲染进程 WASM 或 `yalue/onnxruntime_go`（需带 onnxruntime 动态库，三平台打包成本高） |
| 记忆（core/memory，`memory.json`） | 1k | fs（JSON） | `encoding/json` + 原子写 |
| 定时任务（core/schedule，`tasks.json`） | 0.7k | timers | `robfig/cron/v3` 或自写 ticker |
| 扩展 / 插件（core/extensions、agents） | 4.2k | child_process、fs | `os/exec`；插件 manifest 解析 |
| TTS（core/tts：Edge（WS + Sec-MS-GEC）、云端；host-electron AdvancedTTSEngine、TtsElectronNativeProvider） | 1k + 原生 | `ws`、crypto；Electron 原生 TTS | `coder/websocket`/`gorilla/websocket` 实现 Edge 协议；Azure/OpenAI 走 HTTP；系统 TTS：Mac `say`/AVSpeech（cgo）、Win SAPI（`go-ole`）、Linux `espeak`/speech-dispatcher —— 或放渲染进程 `speechSynthesis` |
| 语音（core/voice：whisper.cpp 进程、Silero VAD worker、云 ASR、Volc） | 2.9k | worker_threads、onnxruntime-web、child_process | whisper.cpp 仍是外部进程（`os/exec`）；Silero VAD 移到渲染进程 WASM（推荐）或 onnxruntime_go |
| 角色包（core/character：CharacterPackService、packProtocol、packResolve） | 0.6k | fs、tar、自定义协议 | `archive/tar`、`compress/bzip2`；资产协议用 Wails AssetServer 中间件 |
| 人设 / 主题 / 语言 / 启动 / 引导 / 诊断 / 安全（persona、theme、i18n、startup、onboarding、diagnostics、security、sandbox） | ~2.2k | fs、crypto | 标准库 |
| 设置存储（`settings.json`、`config.toml`、`ai-providers.json`、`tts-config.json`、`theme.json`、`startup.json`、`system-settings.json` 等 ~30 个文件） | — | fs（**无数据库**，全部 JSON/JSONL/TOML） | `encoding/json`、toml；**同一 userData 目录原地读写**，大幅降低数据迁移风险 |
| 密钥（safeStorage ×7 处） | — | Electron safeStorage（Mac Keychain / Win DPAPI / Linux libsecret） | `zalando/go-keyring`；**注意旧密文需迁移**（§4.5） |
| 窗口（WindowManager、MascotWindowController、desktopPhysics、chatWindowBounds、liveWindows） | — | BrowserWindow ×59、screen ×24 | Wails v3 `application.WebviewWindow`、`Screens` API |
| 托盘（TrayManager） | — | Tray、nativeImage | Wails v3 SystemTray（Linux 未验证） |
| 灵动岛（island/*） | — | 透明置顶窗 | Wails 无边框透明窗（Mac 透明问题同看板娘） |
| 截屏 / 剪贴板 / 通知 / 电源（ScreenCapture、ClipboardGateway） | — | desktopCapturer、clipboard、Notification、powerMonitor | `kbinani/screenshot`、Wails Clipboard、Wails notifications 服务；电源事件按平台实现 |
| 内置浏览器（AgentBrowser） | — | 隐藏 BrowserWindow 抓页 | Wails 隐藏 WebviewWindow 或 `chromedp`（需本机 Chrome） |
| 自动更新（updates.*、`electron-updater`） | — | electron-updater + latest.yml | 自写：GitHub Releases 检查 + 下载 + 签名校验 + 平台替换（`minio/selfupdate` 思路）；见 §4.4 |
| 开机自启 | — | 2.0.5 未发现 `setLoginItemSettings`（未实现） | 如需：`emersion/go-autostart` |
| 资产协议 / CSP / 窗口守卫（assetProtocol、csp、windowGuards） | — | protocol.handle | Wails AssetServer Handler + 响应头 |
| 旧 userData 迁移（legacyUserData） | — | fs | Go 版定位 Electron userData 路径（见 §4.5） |
| 图片生成 | — | 2.0.5 仅有 `cli/harness/generatedImages.ts`（收集 CLI 产出的图片），无独立图像生成服务 | 同 fs 逻辑重写 |

### 1.4 可原样保留的渲染侧

`packages/renderer`、`ai-chat`、`ui`、`i18n`、`avatar-runtime`（Rive，opt-in 时加载）、`character-contract`、`contract`（客户端 + zod）。改动仅限：
1. transport 注入：Electron preload → 本地 WS（POC 已验证，`frameClient`/`websocket.ts` 已存在）；
2. 看板娘入口按设置选择 SVG / Rive（§5）；
3. 去掉对 `window.nomiHost` 类 preload 能力的残余假设（批次 1 用类型检查清扫）。

## 2. 目标架构（摘要，详见 arch-go-wails.md）

```
apps/desktop-go/
  main.go                  组装：core + shell
  internal/contract/       由 zod → JSON Schema → 生成的 Go 类型 + 路由表（生成物，勿手改）
  internal/core/<domain>/  业务（不 import wails）
  internal/shell/          Shell 接口；wailsshell/ 是唯一 import wails 的包（Linux -tags gtk3）
  frontend/                复用 packages/renderer 的构建入口
```
传输默认本地 WS（127.0.0.1 + 随机端口 + 一次性 token）；stream 用 ctx 取消 + abort 帧。

## 3. 批次（按依赖顺序）

每批统一验收：① Go 单测 + 现有 TS 单测通过；② 契约一致性测试（该批过程的 zod 输入/输出 fixture 在 Go 端往返通过）；③ 真实应用中手测该批功能路径；④ `desktop-go.yml` 三平台 CI 绿。估时为一名熟悉代码的工程师 / 智能体的有效人日（含测试），不含评审等待。

| # | 批次 | 范围 | 主要 Go 库 | 额外验收 | 估时 |
| --- | --- | --- | --- | --- | ---: |
| 0 | 规划 + 脚手架（本批） | 计划文档、`apps/desktop-go` 骨架、CI | — | 骨架三平台可构建 | 已完成 |
| 1 | 契约生成 + 传输 + 路由骨架 | zod→JSON Schema→Go 类型生成器（CI 校验无漂移）、WS server、query/mutation/stream/事件、错误码、`dangerous`/`surfaces` 校验；未实现过程统一返回 `NOT_IMPLEMENTED` | `google/jsonschema-go` 或 `omissis/go-jsonschema`、`coder/websocket` | 359 过程全部注册；渲染进程连上不报错 | 4–5 |
| 2 | 外壳基础 | 窗口（对话 / 看板娘 / 岛）、托盘、资产协议+CSP、单实例、userData 路径、日志/诊断、theme/locale/startup/onboarding | Wails v3 | 三平台窗口与托盘可用；Mac 透明结论（§4.3） | 5–7 |
| 3 | 设置与存储 + 数据迁移 | 所有 JSON/TOML 存储原子读写、safeStorage 密文迁移、旧版目录探测 | `go-keyring`、toml | 用 2.0.4 真实 userData 快照升级后设置/历史/记忆不丢（自动化 fixture 测试） | 4–5 |
| 4 | Provider + 网关 | providers.*、gateway 四协议互转与流式、usage/quality 记录 | `net/http` | 四协议对拍现有 TS 网关测试 fixture | 8–10 |
| 5 | AI 运行时 + MCP | 对话流（stream）、工具循环（多步、并行工具、中止）、memory、tools、MCP（stdio/HTTP） | `openai-go`、`anthropic-sdk-go`、MCP go-sdk | 与 TS 版录制回放对拍；取消 < 200ms | 10–14 |
| 6 | 桌面工具 / 工作区 / 权限 | desktop.*、pathGuard（Win 长短路径）、PermissionBroker、Undo/Trash/Audit、文件解析 | `pdfcpu`/`ledongthuc/pdf`、`archive/*` | 复用现有 pathGuard 测试用例 | 6–8 |
| 7 | CLI 编排 + 终端 | harness（63）、cli/cliAccount/cliUpdate/delegate/agents/history、PTY、sqlite 只读 | `creack/pty`、ConPTY、`modernc.org/sqlite` | Win/Mac/Linux 各跑通 Codex/Claude CLI 一次会话 | 10–14 |
| 8 | 知识 / 本地 / 记忆 / 定时 / 扩展 | kb/mem/local/sched/ext/hub | `robfig/cron` | 定时任务跨重启 | 6–8 |
| 9 | 语音 + TTS | Edge TTS、Azure/OpenAI、系统 TTS、whisper.cpp、云 ASR；VAD/OCR/嵌入迁至渲染 WASM | websocket | 三平台播报 + 识别冒烟 | 5–7 |
| 10 | 看板娘 / 角色包 / 岛 / 截屏 / 剪贴板 / 通知 | mascot.*、window.*、character、persona、chatBg、island、screen、物理/穿透；SVG 默认 + Rive 开关 | `kbinani/screenshot` | §5 验收 | 5–7 |
| 11 | 更新 + 打包 + 签名 | 自动更新、三平台安装包（dmg/nsis 或 msi/AppImage+deb）、Mac Developer ID 签名 | Wails packager | 2.0.4→2.0.5 升级路径（§4.4） | 5–7 |
| 12 | 收尾 | 删除 `host-electron` 与 Node 主进程代码、文档、CHANGELOG、E2E 迁移（Playwright → WebView 或 Go 驱动） | — | 全量 E2E 绿 | 4–6 |
| | **合计** | | | | **≈ 72–98 人日** |

依赖：1 → 2 → 3 →（4 → 5）∥ 6 ∥ 8 → 7（依赖 4/6）→ 9、10（依赖 2/3）→ 11 → 12。4/6/8/10 可并行。

## 4. 风险

### 4.1 Go 里没有 Vercel AI SDK 等价物（最高）
`streamText` 的多步工具循环、并行工具调用、`maxSteps`、流式 tool-call delta、Provider 差异抹平、`@ai-sdk/mcp` 都要自写或选框架。方案：A) 官方 SDK + 自写约 1.5k 行 tool loop（推荐，可控）；B) `cloudwego/eino`；C) `langchaingo`。缓解：先把 TS 版的流事件录成 fixture，Go 版逐帧对拍。

### 4.2 PTY / 子进程
`creack/pty` 不支持 Windows，需 ConPTY 单独实现；Windows 路径（d511566c 修的长/短路径）要原样移植测试。

### 4.3 Mac 窗口透明（已知：白底）
Wails v3 Mac 透明需 `BackgroundType: Transparent` + `Mac.Backdrop`/`WebviewIsTransparent`，POC 未成功。若 v3.0.0 修不了：A) 在 `wailsshell` 用 cgo 直接设置 `NSWindow`/`WKWebView` `drawsBackground=NO`；B) 等上游修复；C) Mac 暂用不透明圆角卡片（体验降级）。阻塞看板娘，必须批次 2 内结论。

### 4.4 自动更新
electron-updater 不能用。需自建：GitHub Releases 清单 + sha256/签名校验 + Mac 替换 .app（未公证会被 Gatekeeper 隔离，需清 quarantine 或引导手动安装）+ Win 安装器静默升级 + Linux AppImage 自替换。**关键：已安装的 2.0.4（Electron）用户如何拿到 2.0.5**——electron-updater 会下载 2.0.5 的安装包，需让 2.0.5 产物满足旧 latest.yml 格式与安装器约定，否则用户需手动下载。

### 4.5 用户数据迁移
存储全是 JSON/TOML（无 DB），Go 版读写同一目录即可，但：
- userData 路径：Electron 在 Mac `~/Library/Application Support/<productName>`、Win `%APPDATA%\<productName>`、Linux `~/.config/<productName>`，Go 版必须指向同一目录（不能用 Wails 默认）；
- safeStorage 密文（API Key 等 7 处）：Electron 用 Keychain 中 “<App> Safe Storage” 密钥 + AES（Mac/Linux）或 DPAPI（Win）。Go 可解（Mac 读 Keychain 项、Win `CryptUnprotectData`），首次启动解密后转存 go-keyring；失败则提示重填；
- Electron 自身的 localStorage/IndexedDB（渲染进程存的数据）在 Chromium LevelDB 里，WebView 换了读不到——批次 3 需普查渲染进程是否有持久化在 localStorage 的东西，有则改走契约存储并一次性导出。
- 迁移前做一次备份目录（`<userData>/backup-2.0.4/`）。

### 4.6 其它
- Linux：托盘未验证（需 AppIndicator/StatusNotifier）、无 GPU 机器内存偏高；WebKitGTK 与 Chromium 的 CSS/Canvas 差异（Rive WebGL）。
- Windows WebView2 运行时缺失时的安装引导。
- E2E：现有 Playwright 依赖 Electron，需要改造。
- 工作量大（~3–4 人月），2.0.5 发版时间需重新评估。

## 5. 看板娘：SVG 默认 + Rive 可选

- **设置键**：`mascot.renderer`，枚举 `'svg' | 'rive'`，默认 `'svg'`（等价于“Rive 动画：关”）。存于 `settings.json`，契约新增 `mascot.getRenderer`（query）/ `mascot.setRenderer`（mutation）与事件 `mascot.rendererChanged`（批次 10 加入 zod，生成 Go 类型）。
- **老用户**：升级时也默认 `svg`（统一行为、省内存）；若希望老用户保持动画，可迁移时写 `rive`——见待决问题 Q5。
- **实时切换**：看板娘窗口订阅 `mascot.rendererChanged`，卸载当前渲染器（Rive 需 `cleanup()` 释放 WebGL 上下文）后挂载另一种，不重开窗口；Rive 运行时 `@rive-app/canvas-lite` 动态 `import()`，SVG 模式下不加载（POC 的 `NOMI_POC_MASCOT=rive` 编译开关改为运行时开关）。
- **SVG 模式能力**：静态立绘 + CSS 轻微呼吸/点击反馈（不改 SVG 源文件，仅 transform），说话时可用岛/气泡提示。
- **设置界面文案**（外观 → 看板娘）：
  - 标题：「动态看板娘（Rive 动画）」
  - 开关说明：「开启后诺米会眨眼、说话和做表情。会多占用一些内存和显卡资源，低配电脑建议保持关闭。」
  - 英文：“Animated mascot (Rive)” / “Nomi blinks, talks and reacts. Uses more memory and GPU; keep off on low-end machines.”
- **引导**：onboarding 末尾加一步可跳过的卡片「想让诺米动起来吗？」，按钮「开启动画」/「保持静态」，默认焦点在「保持静态」；无 GPU（WebGL 不可用）时不显示开启按钮并说明原因。
- **验收**：默认安装看板娘为 SVG 且未加载 Rive 包（网络/模块面板验证）；切换 10 次无泄漏（内存回到基线 ±10%）；三平台截图。

## 6. 待用户决策

见 PR / 汇报中的 Q1–Q7。
