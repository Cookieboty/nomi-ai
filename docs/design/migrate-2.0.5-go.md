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

## 0.1 用户决策记录（2026-10-29）

| # | 问题 | 决定 |
| --- | --- | --- |
| Q7 | 发版节奏 | **推迟 2.0.5**，全部迁移完成再发；不拆 2.0.6 |
| Q1 | AI / 工具循环 | **不用任何厂商 SDK**（不用 openai-go / anthropic-sdk-go / genai，也不用 eino / langchaingo）。各协议适配器用 `net/http` + 自写 SSE 解析实现，**分层与模块边界 1:1 对齐现有 Node 版**（§3.1） |
| Q1' | MCP | **默认自研 MCP 客户端协议**（JSON-RPC 2.0 over stdio / Streamable HTTP / SSE），不引入 `modelcontextprotocol/go-sdk`——此项为执行方推断，用户可推翻 |
| Q2 | Mac 透明 | **必须修好**，不接受不透明降级；按需用 cgo 直接操作 NSWindow / WKWebView |
| Q3 | 2.0.4 → 2.0.5 升级 | 方案 B：引导手动下载；不做 latest.yml 兼容。2.0.5 首次启动**必须**迁移 Electron 用户数据（设置 / 历史 / safeStorage 密文） |
| Q4 | VAD / OCR / 嵌入 | 全部在渲染进程跑 WASM；Go 不带 onnx |
| Q5 | 老用户看板娘 | 升级用户同样默认 SVG |
| Q6 | Linux | AppImage + deb；没有 SNI 宿主时允许无托盘降级 |

### 0.2 2.0.4 用户会看到什么（已核对代码）

- 2.0.4（tag `v2.0.4`）的 `UpdateService` 用 electron-updater GitHub provider 读**最新 Release** 的 `latest*.yml`。2.0.4 **没有** #146 的 `releasePending` 处理（该逻辑在 2.0.5 才加入）。
- 2.0.5（Go）Release 不带 `latest*.yml` → electron-updater 抛 `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`（`Cannot find latest-mac.yml in the latest release artifacts`）→ 2.0.4 走 `fail(msg)`，状态为 `error`，设置 → 更新页显示**检查失败 + 原始英文错误 + 「重试」**；启动时的自动检查静默失败，**不会弹窗**，用户看不到有新版本。
- 结论：要实现“弹窗引导手动下载”，需要在 Electron 线发一个 2.0.4.x 小改（识别缺 yml 时去 GitHub API 读最新 tag，弹窗打开下载页），或在 2.0.5 Release 上额外挂一个让 2.0.4 能解析的 yml（会触发其自动下载，不推荐）。**两者都不在本计划范围**，待用户决定（见汇报）。

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
| AI 运行时（ai-runtime: AiSdkLlmProvider、ChatFacade、工具循环） | 10k | `ai`、`@ai-sdk/openai|anthropic|openai-compatible`、zod | 自研：`net/http` + 自写 SSE；各厂商协议适配器 + tool loop 1:1 镜像 Node 分层（§3.1），不用厂商 SDK |
| MCP（ai-runtime mcpBridge / AiSdkMcpPlugin，`mcp.json`） | — | `@ai-sdk/mcp` createMCPClient（stdio/SSE/HTTP） | 自研 MCP 客户端（JSON-RPC 2.0；stdio / Streamable HTTP / SSE） |
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

### 3.1 AI 分层镜像（Node → Go，1:1）

| Node 层 | 现有模块 | Go 包 |
| --- | --- | --- |
| 协议网关内核 | `packages/gateway/src`：`canonical/`（chat/responses/upstream/terminal IR）、`ir.ts`、`ingress.ts`、`upstream.ts`、`stream/`、`request/`、`route/`、`providers/`、`models/`、`privacy/`、`cooldown`/`limits`/`timeouts`/`affinity`、`server.ts`/`worker.ts` | `internal/gateway/{canonical,ir,ingress,upstream,stream,request,route,providers,models,privacy,limits}`；`internal/gateway/server` |
| SSE / HTTP 传输 | gateway `net/`、`stream/` | `internal/gateway/net`、`internal/sse`（自写解析器，含重连与 `[DONE]`） |
| Provider 管理 | `ai-runtime/src/providers`：ProviderService/Store/Router、presets、protocol、secretCipher、usageEvent | `internal/ai/providers` |
| LLM 适配器（替代 AI SDK provider） | `ai-runtime/src/ai-sdk/AiSdkLlmProvider.ts`、`mapTools.ts`、`streamError.ts` | `internal/ai/llm/{openai,anthropic,compatible,gemini}`：各自 `net/http` 请求构造 + SSE 事件 → 统一流事件 |
| 工具循环（替代 `streamText` maxSteps） | `toolCaller.ts`、ChatFacade.agent / withTools | `internal/ai/loop` |
| MCP | `mcpBridge.ts`、`AiSdkMcpPlugin.ts`（`@ai-sdk/mcp`） | `internal/ai/mcp`（自研 JSON-RPC 客户端：stdio / Streamable HTTP / SSE） |
| SDK 门面 / DI | `packages/ai-sdk`（AIClient、facade、di、config） | `internal/ai/facade` |
| 运行时装配 / 契约路由 / 观测 | `AIRuntimeService`、`AiContractRouter`、`IgPluginHost`、`observability/` | `internal/ai/runtime`、`internal/ai/observability` |
| 主进程侧网关服务 | `core/src/gateway`（GatewayProcess/Service/Store、TerminalCommands、PrivacyLog、TabTokens） | `internal/core/gateway` |

约束：Go 包间依赖方向与 Node 包依赖一致（gateway 不依赖 ai；ai/llm 不依赖 runtime），用 `go list` + 测试守卫。

### 3.2 硬性规则：与 Node 版同分层、同技术细节（2026-10-29 用户要求）

Go 版**1:1 镜像** Node 版：模块边界、包/层结构、数据格式、落盘文件名与路径、协议细节（请求/响应形状、SSE 解析、重试、超时、错误码、abort 语义）、工具循环行为、IPC 契约、配置键、算法。**不重新设计、不"顺手改进"**；只有平台强制的差异才允许，且必须登记在 §3.4 偏差表并在每批报告里列出。命名规则：Node 文件 `foo/barBaz.ts` → Go `foo/bar_baz.go`，导出函数/字段名保持同义（camelCase → PascalCase），配置键与 JSON 字段名原样保留（Go struct 用 json tag 对齐，不改名）。

### 3.3 Node → Go 模块映射表（每个 Node 包/目录 → Go 包）

| Node 模块 | Go 包（apps/desktop-go/internal/...） | 备注 |
|---|---|---|
| packages/contract（protocol/wire/router/server/stream/errors/websocket/frameClient） | contract（frames.go 对应 wire+router+server），contract/gen（由 zod 生成） | 帧格式、错误码、abort 语义逐字一致；渲染侧继续用 TS frameClient |
| packages/contract/app（359 过程 + 71 事件） | contract/gen（types_gen.go、procedures_gen.go） | `scripts/go-contract/gen.mjs --check` 防漂移 |
| packages/core/src/createCore.ts、core/ | core（create_core.go） | 装配顺序一致 |
| core/src/{agents,ai,character,chat,cli,desktop,diagnostics,extensions,gateway,i18n,knowledge,local,mascot,memory,onboarding,persona,sandbox,schedule,screen,security,services,startup,theme,tts,usage,utils,voice} | core/{同名目录}（如 core/memory、core/schedule、core/gateway…） | 目录逐一对应，一个 Node 目录一个 Go 包 |
| packages/gateway/src/*.ts（affinity、bridge、commit、config、cooldown、customTools、errors、fixes、ingress、intent、ir、learn、limits、metrics、models、probe、quality、reasoning、responseFixes、sessions、timeouts、tokens、toolNames、trace、transforms、upstream、usageTap、util、worker） | gateway（同名 .go 文件：affinity.go、cooldown.go、timeouts.go…） | 重试/冷却/超时常量照抄 |
| gateway/src/{canonical,clients,models,net,privacy,providers,request,route,spec,stream} | gateway/{canonical,clients,models,net,privacy,providers,request,route,spec,stream} | SSE 解析逐行对照 stream/ |
| gateway/src/server.ts | gateway/server | 本地 HTTP 入口，路由与状态码一致 |
| packages/ai-sdk（AIClient、config、di、errors、facade、types） | ai/sdk（ai_client.go、config、di、errors.go、facade、types） | 自研替代 Vercel AI SDK 的那一层，接口形状一致 |
| packages/ai-runtime（AIRuntimeService、AiContractRouter、AiSdkBooter、IgPluginHost、IpcAdapter、NoopLifecycle、ObservabilityBridge、env、igPlugins、logger） | ai/runtime（ai_runtime_service.go、ai_contract_router.go、ai_sdk_booter.go、ig_plugin_host.go、ipc_adapter.go…） | |
| ai-runtime/src/providers（含 AiSdkLlmProvider） | ai/runtime/providers，LLM 协议适配 ai/llm/{openai,anthropic,compatible,gemini} | net/http + SSE 自研，不用厂商 SDK |
| ai-runtime/src/ai-sdk（toolCaller、mcpBridge） | ai/runtime/aisdk/{toolcaller,mcpbridge} | 工具循环步数上限、并发、错误回填格式一致；MCP 自研（假设，可改） |
| ai-runtime/src/observability | ai/runtime/observability | |
| packages/host-ports | hostports | 宿主端口接口，Go interface 一一对应 |
| packages/host-node（core、processes、websocket） | hostnode（core.go、processes.go、websocket.go） | |
| packages/host-electron（main、ai、chat、core、host、island、mascot、security、services、utils、brand、schemePrivileges） | host（main.go）+ shell/wailsshell（窗口/托盘/灵动岛）+ host/{ai,chat,core,security,services,utils} | preload.ts 无对应（Wails 注入 runtime）→ 偏差 D1 |
| packages/cli-sdk（carry、child、driver、drivers、events、external、launch、lines、manifest、models、plugin、rpc、trace） | clisdk/{同名} | 子进程行协议、manifest 格式不变 |
| packages/cli-plugins（claude、codex、dsh、gemini、grok、gateways、shared、generated） | cliplugins/{同名} | |
| packages/character-contract（contract、copy、migrations、node、paths、schemas、validate） | charactercontract（同名 .go） | 角色包路径、迁移步骤一致 |
| packages/{renderer,ui,ai-chat,ai-sdk-client,avatar-runtime,voice,i18n,types,bundle-ig-*} | 不迁移，原样留在渲染侧（TS） | voice 的 VAD/OCR/embedding 在渲染侧 WASM（Q4） |

### 3.4 偏差表（只登记平台强制的差异）

| # | Node 版 | Go 版 | 原因 |
|---|---|---|---|
| D1 | Electron IPC + preload.ts 暴露 bridge | 渲染侧经本地 WebSocket 发同样的 contract 帧（contract/websocket.ts 已有该传输） | Wails 没有 preload/contextBridge；帧格式不变 |
| D2 | safeStorage 加解密密钥 | 系统钥匙串（mac Keychain / Win DPAPI / libsecret）；首启读取 Electron 的 safeStorage 数据迁移 | Go 里没有 safeStorage |
| D3 | electron-updater + latest.yml | 2.0.5 手动下载引导（Q3 方案 B） | 用户决策；跨运行时无法沿用 |
| D4 | onnxruntime-node（主进程） | 渲染侧 WASM | 用户决策 Q4，Go 无成熟 onnx 绑定 |
| D5 | BrowserWindow 透明 | Wails 窗口；mac 需 `-tags private_mac_apis`（WKWebView drawsBackground） | Wails v3 默认不开私有 API |
| D6 | Electron Tray | Linux 无 StatusNotifierWatcher 时不建托盘，对话窗作入口 | Q6；Electron 在此情况下同样无托盘，Go 版改为显示对话窗 |
| D7 | ~~node-pty~~ **作废**（见 D-B7-2） | 仓库里没有 node-pty：CLI 一律 `child_process` 管道 | — |
| D8 | 未注册过程不存在 | 迁移期桩返回 `UNAVAILABLE` | 临时，全部实现后删除 |
| D9 | 默认 Rive 看板娘 | 默认 SVG，Rive 可选 | 产品决策 Q5 |
| D10 | Go 与 Electron 共用同一 userData 目录（§4.5 初稿） | Go 版单独用 `Nomi`；首启从 `@nomi-ai/electron`（及旧 `@ig-live/electron`）**复制**进 `Nomi`，不改、不删 Electron 原目录 | 用户要求升级后仍能打开 Electron 构建；同目录会互相踩配置/钥匙串 |
| D11 | 渲染侧 `ai-chat:*` 会话存在 Chromium localStorage（LevelDB） | Go 尽力从 `Local Storage/leveldb` 抽出 `ai-chat:*` 键写入 `userData/ai-chat/`；抽不出时不报错，会话文件层（`*.jsonl`）照常复制 | LevelDB 格式/加密因 Chromium 版本而异，无法保证 100% |
| D12 | `writePrivateFile*` 在 Windows 上对文件跑 icacls | Go 版只保证 0600 + 目录 0700，跳过逐文件 ACL | Go 无稳定等价；userData 本就在用户目录下 |
| D13 | GatewayStore / keys 的 `encryption: safeStorage \| none` | 迁移后新增 `encryption: keyring`（磁盘存钥匙串 account id 的 base64） | Go 无 safeStorage，密文改放 OS 钥匙串 |
| D14 | Linux 上 Electron safeStorage（libsecret + Chromium OSCrypt）可解 | 本批 Linux `Available()=false`，safeStorage 密文进 `secretsFailed`，提示用户重填；`encryption=none` 仍迁 | Chromium OSCrypt 派生较重，先保证失败路径可读 |
| D15 | gateway `stream/`、`canonical/`、`spec/` 互相 import（TS 允许循环引用） | Go 拆出叶子包 `stream/sse`、`stream/events`、`spec`、`util`、`ir`；`canonical` 依赖 `sse`，`stream` 依赖 `canonical`；函数与字段顺序不变 | Go 禁止循环 import，只改包边界不改逻辑 |
| D16 | `createStreamConverter` 内部按 `opts.fixes` 自建 `EventFixer` | Go `ConvertOptions` 直接收 `Seed`、`Fixer`（接口）与 `FixEvents` 钩子，由调用方按 fixes 构造 | fixer 尚未移植（4b），先留接口，语义等价 |
| D17 | JSON 对象 `Record<string,unknown>` 天然保序 | Go 用自研有序 `util.Obj`，数字按 JS 规则格式化 | 保证与 Node 输出逐字节一致 |
| D18 | `TerminalWatch` 在 `canonical/terminal.ts` | Go 放在 `stream` 包（`stream.NewTerminalWatch`），`ConvertOptions.fixes` 改为 `stream.WithFixes(opts, fixOptions)` 填充 | Go 包不能互相引用（canonical ← stream ← canonical 会成环）；行为不变 |
| D19 | ~~JS 字符串可含"半个 emoji"（孤立代理）~~ **已消除** | Go 用 WTF-8 字节表示孤立代理：`UTF16Tail/UTF16Slice0` 切在 emoji 中间时和 JS 一样留半个，`JSON.parse` 保留 `\udXXX`，`Stringify` 原样写回 `\udXXX`；见 `util/surrogate_test.go`（数值取自 Node） | 无行为差异 |
| D20 | ~~纯数字参数名在 JS 对象里排最前~~ **已消除** | `util.Obj.Set` 按 JS 规则：数组下标型键（0…2^32-2）升序在前，其余按插入顺序；fixture `objkeys.json` + `fixes.json` 新增用例 | 无行为差异 |
| D21 | ~~主机名未按 WHATWG 规范化~~ **已消除** | `net.ParseURL/WhatwgHost` 实现 WHATWG 主机解析（小写、IDNA/UTS46、IPv4 十六进制/八进制/简写、IPv6 压缩、默认端口去掉），报错文案与 Node 一致；fixture `net.json` urls 33/33 | 无行为差异 |
| D22 | ~~代理环境变量处理不同~~ **已消除** | 按 undici 7 EnvHttpProxyAgent 复刻：`http_proxy`/`https_proxy`（小写优先、空串算已设置，https 退回 http）；`ALL_PROXY` 和 Node 一样只用于判断"代理环境已开启"，并不真走代理；`no_proxy` 每次请求现读（`*`、`host:port`、`.后缀`）；一律 CONNECT 隧道，请求头顺序与 Node 一致，仅 HTTP/1.1；支持 socks5；钉 IP 只对目标主机。fixture `proxy.json` 38/38 | 无行为差异（钉 IP 用 context 而非 AsyncLocalStorage，仅实现方式不同） |
| D23 | JS 正则 `/i`（无 u 标志）大小写折叠只按 toUpperCase，非 ASCII 字符不会折成 ASCII | Go RE2 `(?i)` 会把 `ſ`(U+017F)↔`s`、`K`(U+212A)↔`k` 视为相同；`\s` 已按 JS 空白集合替换（`util.JSRe`）| RE2 无开关；只影响报错文本/模型名里出现这两个罕见字符的情况 |
| D-B6-1 | ~~desktop 文案走 core/i18n~~ **已消除** | desktop 直接用 `core/i18n`（`tr` 别名），临时 `desktop/tr` 已删除 | 无行为差异 |
| D-B6-2 | ~~reminders 复用 core/schedule 的 recurrence~~ **已消除** | `reminders/shared_recurrence.go` 只做类型别名 + 转调 `core/schedule`，临时副本已删除 | 无行为差异 |
| D-B6-3 | ~~Windows 上 `fs.realpathSync.native`~~ **已消除** | Windows 用 `GetFinalPathNameByHandle`（`realpath_windows.go`），其他平台 `EvalSymlinks`（与 libuv realpath 一致） | 无行为差异 |
| D-B6-4 | 看板娘专属过程按 `event.sender` 判定 | 按 `contract.Caller.Surface == "mascot"` | **不可观察**：Caller.Surface 由宿主按发起窗口填写，与 Node 的 sender→窗口映射一一对应，对渲染端和契约调用方结果相同；仅实现方式不同 |
| D-B6-5 | 本轮“已读文件”污染标记用 WeakMap(signal) | 用 context 值携带 | **不可观察**：两者生命周期都绑定单轮请求，标记的读写点与结果相同；仅实现方式不同 |
| D-B6-6 | ~~落盘 JSON 原样保留未知字段、键序随对象~~ **已消除** | desktop 设置 / reminders 写回保留未知字段与键序（`scope_raw_test.go`、`reminders/raw_test.go`） | 无行为差异 |
| D-B6-7 | ~~parse 在 worker_threads + resourceLimits 里跑~~ **已消除** | 在限内存的 worker 子进程里解析（同 runParse 的超时 / 内存上限 / 错误映射，`parse/worker_test.go`） | 无行为差异 |
| D-B6-8 | pdf 用 unpdf（pdf.js v6.1.200 getTextContent） | 逐函数移植 pdf.js 文本抽取（`parse/pdfjs_*.go`：词法、预处理器、TextState、addFakeSpaces/compareWithLastPosition、bidi、NFKC 表、标准字体宽度表由 `scripts/go-pdfjs/gentables.mjs` 从 pdf.js 源码生成）；19 个 fixture（含 CID/ToUnicode、裁剪框、Form XObject、gs 字体、负间距、旋转、T*、上标、缺字体）与 unpdf 输出逐字一致 | 剩余差异（fixture 未覆盖）：预定义 CJK CMap / bcmap（usecmap）、从内嵌字体程序推导编码与宽度、Type3 isCharBBox、中文字体名特例、标准字体数据假定、DCT/A85/AHx 内联图结束检测为近似、非数值操作数的 JS 隐式转换、Go 与 V8 Unicode 表版本差 |
| D-B6-9 | ~~`Date.parse` 全格式~~ **已消除** | 逐行移植 V8 `Date.parse`（ES5 ISO + legacy dateparser），node fixture 全过（`reminders/dateparse_test.go`） | 无行为差异 |
| D-B6-10 | ~~takePendingSummary 只在送达失败时留槽~~ **已消除** | `EmitTo` 返回送达结果，仅未送达时留槽 | 无行为差异 |
| D-B6-11 | createP2Tools 注册 reminder-restore 撤销、产出 AI ToolDefinition | 撤销钩子在 Service 构造时注册；ToolDefinition 留给批次 5（AI 工具循环） | **不可观察**：撤销钩子在任何撤销发生前已注册，行为相同；ToolDefinition 在 AI 工具循环（批次 5）合入前没有调用方 |
| D-B6-12 | ~~按 surface 定向 send 事件~~ **已消除** | `Router.EmitTo(surface, …)` 定向投递 | 无行为差异 |
| D-B6-13 | ~~worker 崩溃/退出码映射成 `crash` 错误~~ **已消除** | worker 子进程退出码 / 崩溃按 runParse 同样映射为 `crash` | 无行为差异 |
| D-B10-1 | ~~岛的显示模式恒为 `pill`~~ 已消除 | `island.Mode/HasNotch` 逐行移植 geometry.ts（darwin + 内建屏 + 菜单栏 ≥ 30pt，含 `CD_ISLAND_SIMULATE_NOTCH`），主屏几何来自 Wails `Screen.GetPrimary()`；sanitizeIsland 与刘海判定由 `scripts/parity/record-island.mjs` 从 Node 录制（1692 + 486 条）全部一致。残留：Wails 不提供 `display.internal`，按「未知=内建」处理（与 Electron 缺省一致）；岛窗口的 notch 几何/展开动画仍按胶囊布局 | 外接屏菜单栏 ≥30pt 时可能误判为 notch（mac 外接屏菜单栏 ~25pt，实际不会） |
| D-B10-2 | ~~角色包校验是宽松子集~~ 已消除 | `internal/core/charcontract` 逐行移植 character-contract（V8 JSON.parse 报错文本、zod v4 语义、validatePack/迁移/relax、readPackDirSync 的 WHATWG UTF-8 解码与 UTF-16 排序、loadPackAt）；金样由 `scripts/parity/record-character-contract.mjs` 从 Node 录制：1482 条 JSON、4480 条 schema、702 个整包（严格/lenient/loadPackAt）全部一致。残留：clips 含 null 时 Node 抛 TypeError，Go 的 LoadPackAt 把它当作该候选无效（理由为同一错误文本） | 仅 clips 含 null 的坏包：Node 主进程抛错，Go 跳过该包 |
| D-B10-3 | ~~看板娘物理/漫游/点击穿透未移植~~ 已消除 | `internal/core/mascot` 移植物理与窗口控制器（Node 录制 goldens，含 arm64 FMA 防融合），setShape/setHit/wanderNow/debugSnapshot 均已实现 | 无 |
| D-B10-4 | 渲染器选择引导卡在 POC 对话页 | 新设置 `mascot.renderer`（svg\|rive，默认 svg，升级用户也是 svg）；引导最后一张「想让诺米动起来吗？」（默认焦点「保持静态」，无 WebGL 时隐藏「开启动画」）暂放在 POC 对话页、用 localStorage 只问一次，等引导页迁过来再挪 | 无 |
| D-B10-5 | ~~`chat-asset://`、`character-pack://` 协议未在 Go 壳注册~~ **已解决（处理体零偏差；传输形态有剩余差异）** | `internal/core/assetproto` 逐字移植 resolveChatAssetUrl / resolveCharacterPackUrl / 两张 MIME 表 / 响应体（整读入、`content-type`/`content-length`/`access-control-allow-origin: *`/`cache-control: no-store`，失败一律 404 `not found`；Electron 同样不处理 Range，恒 200 全量）。golden：`scripts/parity/record-asset-protocols.mjs` 用真实 `Request` 驱动 Node handler（chat 44 + pack 39 地址，含 `..`/`%2e%2e`/`%2f`/`%00`/符号链接越界/大小写/端口/用户信息，16 条 MIME），`TestProtocolParity` 比 resolved 路径与 status/headers/body；变异检查（去掉空段拒绝）即失败。剩余差异：Wails v3.0.0 只把硬编码的 `wails` scheme 交给 Go（mac `setURLSchemeHandler`、Linux `register_uri_scheme`、WebView2 需建 Environment 时注册），无法注册任意 scheme，故经资产服务器网关 `/__scheme/<scheme>/<host>/<path>` 还原原始地址再交给同一处理体（Go 端 `assetproto.GatewayURL`；前端唯一换址点 `frontend/src/schemeUrl.ts` 的 `toGatewayUrl`/`resolveAssetUrl`，两边共用 `testdata/gateway_urls.json`，CI 用 `scripts/parity/check-scheme-url.mjs` 校验 TS 一侧；已逐平台核对 Wails v3.0.0 源码：mac `setURLSchemeHandler:forURLScheme:@"wails"`、Linux `webkit_web_context_register_uri_scheme(ctx, "wails")`、Windows 只加 `AddWebResourceRequestedFilter("*")` 且不传 CustomSchemeRegistration，应用选项里也无自定义 scheme 项）；网关下非法 `%` 序列由 Go HTTP 服务器先回 400（Electron 404），两者皆失败。各平台 CI 现场用 Node 录制 golden 后比对（大小写变体、反斜杠、符号链接均实测，不跳过） | 若 Wails 开放自定义 scheme 注册则去掉网关 |
| D-B10-7 | ~~灵动岛窗口固定 360×72 胶囊占位页，不按刘海布局~~ **已解决（几何与页面零偏差；通知管线有剩余差异）** | `island/geometry.go` 移植 islandGeometry / islandHeight / clampIslandHeight / islandWindowRect（常量逐一对应）；页面 islandHtml 不手抄：`scripts/parity/record-island-geometry.mjs` 用哨兵几何调用真实 islandHtml 生成刘海/胶囊两份逐字模板 `islandpage_tpl.go`，Go 只替换数值（JS 数字格式化）。golden 978 例（3 平台 × 55 显示器 × auto/pill，每例 15 个测量值的 clamp + 窗口矩形）+ 48 份整页逐字比对；变异检查（NotchPad.top 4→5）即失败。壳按 islandWindowRect 以屏幕绝对坐标建窗，页面由资产服务器 `/__island.html` 按当前几何现场生成（Electron 用 data: URL）。剩余差异：Wails ExecJS 拿不到返回值，故用页面自带 `__island.show(n)`（prepare+play 合一）而非 prepare→量高→setBounds→showInactive→play，窗口保持初始岛高；页面 `hidden:` 标题与 `#open-` 点击回传未接（Wails 无标题/hash 变化事件），收起后窗口透明留在原处 | 用 Wails 事件从页面回传高度/隐藏/点击，补齐 pump 管线 |
| D-B10-6 | 聊天背景缩放输出像素非逐字节一致 | 规则与 Electron 1:1：解码集仅 PNG→JPEG（与 nativeImage.createFromBuffer 相同，GIF/WebP/BMP/坏数据按 0×0 原样复制）；长边 >2560 才缩，目标尺寸按 Chromium float32 公式 ToRoundedInt(2560×(1/aspect))；quality 'best' = Lanczos3（预乘、可分离）；.png 存 PNG、其余转 .jpg q85；缩出 0 边时写 0 字节文件。chatbg/testdata/image.json 由真实 Electron 44.9.3 录制（scripts/parity/record-chatbg-image.cjs，172 例），TestImageParity 比对 outExt/是否缩放/格式魔数/输出尺寸；变异（尺寸舍入改截断）24 例失败 | 仅像素与压缩字节不同：Skia 用 14 位定点 SIMD Lanczos3 与自带 PNG/JPEG 编码器，Go 用浮点核与标准库编码器 |
| D-B11-1 | mac 只做 Developer ID 签名，不公证 | `packaging/package.sh` 手工组 `Nomi.app`（Info.plist 键对齐 2.0.4：bundle id、`nomi` URL scheme、productivity 类别、日历/麦克风/AppleEvents 用途串；entitlements 原样复制），`codesign --options runtime --timestamp`；dmg 用 hdiutil、zip 用 ditto；secret 缺失时退化为 ad-hoc 并告警 | 首次打开需右键「打开」或在「隐私与安全性」放行（Electron 2.0.4 同样未公证） |
| D-B11-2 | mac x64 由 arm64 runner 交叉编译 | `CC="clang -arch x86_64" GOARCH=amd64`（cgo），最低系统 11.0；CI 只在 arm64 上做安装/启动验证 | x64 包仅静态校验（签名、lipo），未在 Intel 机实跑 |
| D-B11-3 | 不再产出 `latest*.yml` / `*.blockmap`，改为 `latest-go.json` + `SHA256SUMS` | Go 版不用 electron-updater（无差分、无自动替换）；`packaging/update-manifest.py` 生成 schemaVersion=1 清单（各平台 file/url/size/sha256），2.0.5+ 从 `releases/latest/download/latest-go.json` 检查后弹窗引导下载。2.0.4 的 electron-updater 读 `latest*.yml`，Go release 不提供 → 2.0.4 用户走手动下载（方案 B） | 2.0.4 不会收到应用内升级提示；Go 版 `updates.*` 处理器尚未接入此清单（仍为桩） |
| D-B11-4 | Windows 安装器为手写 NSIS（非 electron-builder 模板） | `packaging/windows/installer.nsi` 复刻 oneClick 语义：按用户安装 `%LOCALAPPDATA%\Programs\Nomi`、同一卸载 GUID `{b397f92d-158f-5b6d-b066-7aee5a5f3bb7}`（覆盖升级 2.0.4 时先静默跑旧卸载器并保留数据）、桌面/开始菜单 `Nomi.lnk`、HKCU `nomi` 协议、`/S` 静默与 `--force-run`、卸载不删用户数据；缺 WebView2 时静默运行随包 Evergreen bootstrapper。未做：快捷方式 AppUserModelID、安装器多语言界面、Windows 代码签名（2.0.4 也未签） | Windows 通知/任务栏分组 ID 可能与 Electron 不同 |
| D-B11-5 | AppImage 不内置 WebKitGTK/GTK3 | Electron AppImage 自带 Chromium；Go 版依赖系统 `libwebkit2gtk-4.1-0`、`libgtk-3-0`（Ubuntu 22.04+/Debian 12+ 默认可装）。新增 deb（nfpm，声明上述依赖，`/opt/Nomi` + `/usr/bin/nomi`，注册 `x-scheme-handler/nomi`） | 无 WebKitGTK 4.1 的发行版上 AppImage 无法启动，需先装依赖 |
| D-B11-6 | 托盘图标改为内嵌 PNG | mac 用 `trayTemplate@2x.png`（模板图），Win/Linux 用 `app-icons/sunset/tray.png` 的 @2x（= Electron 默认图标变体）；用户切换图标变体后托盘不跟随（Electron 跟随） | 非默认图标变体用户的托盘图标与 Electron 不同 |
| D-B11-7 | 发布 workflow 与 ci.yml 的 Electron tag 任务需二选一 | `desktop-go-package.yml` 的 release-draft 只在 tag ref 上手动触发，且 publish 需显式 `publish=true`；ci.yml 在 `v*` tag push 时仍会构建并上传 Electron 包到同一 draft | 打 v2.0.5 tag 前（批次 12）须先下线 ci.yml 的 Electron 发布任务 |
| D-B8-1 | `knowledge.ts` 契约 77 个过程（批次说明） | 实际 75 个过程 + 11 个事件，Go 全部注册（`knowledgehandlers.Handlers`，单测断言 75） | 以契约源码为准，说明里的数字有误 |
| D-B8-2 | 本地模型注册进 AI 网关 / 设为主模型（`gateway.upsertProvider`、`setNomiMain`、`confirmPrivateHost`） | Go 通过 `local.GatewayLike` 接口调用，main.go 暂未接入（nil → 跳过注册），TODO(batch-4/5) | 网关服务属于批次 4/5，尚未合入 |
| D-B8-3 | `desktop.say`、`broker.setLocalOnly`、HostPorts（打开对话框、OCR 等） | **部分**：DesktopService（批次 6）已可注入；`say`、OCR 等 HostPorts 仍用 `deps.NoopPorts` 假实现（对话框按“已取消”），TODO(batch-6 宿主端口) | HostPorts 宿主实现尚未全部合入 |
| D-B8-4 | AI `complete`（摘要、问答、主动聊天） | `deps.UnavailableComplete`：返回 KB_/MEM_/SCHED_ 声明里的失败码，TODO(batch-4/5) | 依赖 ai-runtime（批次 4/5） |
| D-B8-5 | ~~`os.totalmem()`~~ **已消除** | Linux `sysinfo`、mac `hw.memsize`、Windows `GlobalMemoryStatusEx` | 无行为差异 |
| D-B8-6 | ~~llama-server 被信号结束时 `exit` 事件~~ **已消除** | Unix 报 `code: null` + 信号名；Windows 与 Node 一样以 TerminateProcess 退出码上报 | 无行为差异 |
| D-B8-7 | ~~数据导出用 JS zip 库~~ **已消除** | 移植 fflate zip 写出（按 readdir 顺序、同样的头字段），`local/fflatezip_test.go` 与 Node 产物逐字节一致 | 无行为差异 |
| D-B8-8 | MCP 密钥用 safeStorage 加密写进 `mcp.json` | 写入系统钥匙串（`security.NewSecretBox("extensions")`），磁盘上存 `enc:<base64 id>`，同 D13 | Go 没有 safeStorage |
| D-B8-9 | ~~导入技能时用 `O_NOFOLLOW` 打开文件~~ **已消除** | Windows 用 `FILE_FLAG_OPEN_REPARSE_POINT` 打开并拒绝重解析点（`nofollow_windows.go`），Unix `O_NOFOLLOW` | 无行为差异 |
| D-B9-1 | 豆包（火山引擎）流式 ASR / 一次性识别走 WebSocket 二进制协议 | 设置、密钥（`volc-key.json` 加密）、就绪检查、审计、`voice.volcTest` 的入参校验全部按 Node；真正联网的识别返回 `failed`「Doubao streaming ASR is not available in the Go host」，`voice.streamPush/streamCancel` 返回 `false` | 批次范围排除 Volcengine |
| D-B9-2 | VAD 在宿主侧加载 silero 模型 | VAD 留在渲染器 WASM；`voice.vad*` 只回 `{kind:"energy"}` / `0` / `null` | 批次约定 |
| D-B9-3 | 看板娘 `voiceSettings` 原样合并保存（含未知键） | 经类型化 ConfigService 保存，`voiceSettings` 下未知键丢弃 | Go 配置是结构体 |
| D-B9-4 | `X-Timestamp` 用 V8 `Date#toString()`，括号内时区长名来自 ICU | 同格式；时区长名按 IANA 名查表，查不到回退 ICU 写法 `GMT+08:00` | Go 无 ICU；golden 在 UTC 下逐字节一致 |
| D-B9-5 | `ws` 客户端握手默认协商 permessage-deflate、Node TLS 指纹 | coder/websocket，请求头顺序与值同 Node；压缩扩展/TLS ClientHello 不同 | 无 vendor SDK 约束下的传输层差异 |
| D-B9-6 | `fetch` + `FormData`（undici 默认头、`----formdata-undici-` 边界） | net/http multipart，字段顺序/文件名/类型/值与 Node 一致（mock 服务对比），边界串与默认头不同 | 传输层 |
| D-B9-7 | whisper-cli 失败时 Node `execFile` 的错误文本 | stderr 末尾 300 字符同 Node；无 stderr 时按 `Command failed: …` 近似拼接 | Go exec 错误形态不同 |
| D-B9-8 | 对话窗刚创建时等待 `did-finish-load` 再注入语音文本 | 新显示时固定延迟 500ms 再发 `voice.inject` | Wails 无同名事件 |
| D-B7-1 | ~~dsh 解析器遇到 `"null"` 入参时抛 TypeError~~ **已消除** | Go 解析器 `panic(clisdk.JSThrow)` 复现抛出；nodeproc 的 stdout/stderr/error/exit/close 派发统一经 `jsrt.Dispatch`（EventEmitter 语义）：抛出的监听器之后的监听器跳过本事件、本 chunk 余下行丢弃、交给进程级 uncaughtException 钩子（生产环境退出），解析器跨行状态照常保留。golden 录了 `{throw}` 及其后续行 | 无行为差异 |
| D-B7-2 | 计划里的 PTY（creack/pty + ConPTY） | 不用 PTY：Node 的 CLI 全部走 `child_process` 管道（`harness/spawn.ts`），Go 用 `os/exec` 管道，参数 / env / cwd / 信号 / 杀进程树逐项对齐 | 用户已确认（2026-10-29）；跟随 Node 实际实现，不是平台差异 |
| D-B7-3 | cli-sdk 驱动里 JS `undefined` 值的键（AppServer `finish` 的 `error: undefined`）、非字符串 thread/turn/session id | Go `util.Obj` 不存 undefined：不设该键（JSON 输出与读值完全一致，仅 `'error' in r` 不同，调用方无此用法）；非字符串 id 经 `JSString` 转字符串（真实 CLI 只回字符串） | 无可观察差异；driver golden 10 场景 / 117 条覆盖 |
| D-B7-4 | cli-sdk launch 的 Node 错误信息（`linkShared` 失败原因、`mkdirSync` 抛错） | Go 按 libuv 格式拼 `CODE: desc, syscall 'p'[ -> 'dest']`；错误码映射覆盖常见 errno / Win32 子集（EEXIST/EPERM/EACCES/ENOENT/ENOTDIR/EROFS/EISDIR/ENOSPC/EINVAL/ELOOP/ENAMETOOLONG/EBUSY/EIO），其余报 `UNKNOWN: unknown error` | 仅罕见错误码的提示文案可能不同；常见路径有 POSIX golden（launch 6 场景）与 Windows 夹具测试 |
| D-B7-5 | `canonicalDir` 的 `realpathSync.native` | POSIX 用 `filepath.EvalSymlinks`（等价 realpath(3)）；Windows 用 `GetFinalPathNameByHandleW` 并剥 `\\?\` / `\\?\UNC\`（同 libuv）。junction 按 libuv `fs__create_junction` 写 reparse 数据（Substitute/PrintName 结尾补 `\`） | 无行为差异；macOS 上大小写不敏感卷的大小写规范化依赖系统 realpath，Go EvalSymlinks 不改大小写（Node native 亦不改） |
| D-B7-6 | `detect.ts` 的 mock CLI 根目录：前两项相对 `__dirname`（bundle 目录），后两项相对 cwd | Go 无 `__dirname`：`cli.MockCliRoots` 为可注入变量，默认只含两项相对 cwd 的候选（与 Node 后两项相同）；宿主在 batch 4/5 接线时把打包后的 mock-cli 目录 prepend 进来（接线点） | 未接线前，仅 `NOMI_MOCK_CLI` 开发模式下从 bundle 目录查找 mock 二进制的路径缺失；cwd 候选与顺序与 Node 一致 |
| D-B4d-1 | server.ts 响应头的线上顺序 | 已对齐：头名大小写、头集合与值。录制发现 Node 默认就发 `Date`（`sendDate` 默认 true，server.ts 没关），所以 Go 的 `Date` 保留；补上 Node 自动加的 `Connection: keep-alive` + `Keep-Alive: timeout=5`（server `IdleTimeout` 同为 5s），没 Content-Type 时用 nil 关掉 Go 的嗅探；头名通过直接写 map 保持 Node 的写法（如 `x-nomi-served-model` 小写）。e2e 新增 `rawNames` 比对（抓客户端 socket 上的原始响应头名，区分大小写）60/60，去掉 Keep-Alive 的变异 40 例失败。**剩下的差异只有顺序**：Go 的 `Header.Write` 按键排序写出，不劫持连接就无法控制 | HTTP 头顺序不属于语义；客户端（CLI / SDK）不依赖 |
| D-B4d-2 | ~~上游请求的 `accept-encoding`~~ **已消除** | 实测 undici 7.30（网关实际用的 `import('undici')`）：没有该头时 http 加 `gzip, deflate`、https 加 `br, gzip, deflate`，带 Range 先追加 `identity`，同名值合并成一行；响应按 content-encoding 从后往前解码 gzip/x-gzip、deflate（zlib/raw 自动判别）、br、zstd，不认识的编码整层不解码，超过 5 层失败，HEAD/CONNECT/101/204/205/304 不解码，content-encoding/content-length 头原样保留，截断流按 SYNC_FLUSH 不报错。Go 关掉 net/http 透明 gzip（`DisableCompression`），`net/decode.go` 逐条实现（brotli / zstd 用纯 Go 解码库，非厂商 SDK）。golden `scripts/parity/encoding.mjs` 26 例（`TestEncodingParity`），变异检查（去掉 x-gzip / 打开透明 gzip）即失败；https 与 zstd 由单测覆盖（录制用的 Node 22.14 无 zstd，Electron 44 的 Node 有） | 无行为差异 |
| D-B4d-3 | ProviderService 的 `test` / `testDraft` / `fetchModels` / `fetchModelsDraft` 与路由 registry（RoutedLLMRegistry 实现） | 本批未移植：需要 ai-sdk 模型调用与 registry（批次 5）。`providers.Service` 已留 `RoutedRegistry` 接口与 `GetRegistry`；main.go 传 `nil`（= Node 启动早期 registry 尚未就绪的状态） | 批次 5 接入；契约里的 `providers.*` 四个过程不依赖这些方法 |
| D-B4d-4 | trace 落盘里请求头的键顺序 | trace 记录的请求头按 Go `http.Header` 遍历后排序写出；Node 按 IncomingMessage 的原始顺序。键集合、值与打码（`RedactHeaders` golden）一致，trace parity fail=0 | JSON 对象键顺序，查看器不依赖 |
| D-B4d-5 | ~~ProviderStore 只在内存~~ **已消除** | provider 持久化改为与 Node 相同的 GatewayStore：`userData/gateway/store.json`，JSON.stringify(_, null, 2) 同序同排版，`enc`/`encryption`、`tokenEnc`/`tokenEncryption`、`privacyKeyEnc` 语义一致；safeStorage 密文由无状态 SecretBox（54903b2b）产生。`init()`（migrateLegacy → normalizeCliAssignments → ensurePrivacyKey → save → archiveLeftoverLegacy，含 .migrated-<ts> / .corrupt-<ts>）逐步移植，`internal/core/gwstore/testdata/gwstore.json`（Node 真实 GatewayService 录制，8 场景含重启）逐字节比对；Electron 迁移不再改写成 `keyring`，而是就地换成 Go safeStorage 密文（含 cli-providers keyEnc）；2.0.4 迁移+重启测试 `TestProviders204MigrationAndRestart` | runtimeConfig / modelMeta 消费在批次 5 |
| D-B4d-5b | GatewayStore 读兼容 `encryption:"keyring"` | 批次 3 早期迁移写过 `keyring`（enc=base64(账户名)），Go 读取时经 KeyringGet 解出；Node 无此值。另：Go 运行时 Encrypt 失败回退 `none`（Node createSafeStorageCipher 在不可用时同样是 none） | 无（仅兼容旧 Go 构建写出的文件） |
| D-B4d-6 | `gateway.upsertProvider` / `gateway.removeProvider` 等供应商写操作 | 属于 GatewayService（批次 5），本批只注册 shell.ts 的 `providers.presets/meta/state/setActive`（替换 procs 占位）。ProviderStore 的 routes/usage 若在文件里是数组，Go 用旁路表保存非下标属性以复现 JS 数组上挂属性的行为（实际文件不会出现） | 无可观察差异 |

### 3.5 一致性测试策略（golden，Node 与 Go 同输入对比输出）

1. **录制**：在 Node 版加一个测试专用 harness（`scripts/parity/record.mjs`），对每个模块把输入（过程名 + input、上游 HTTP 响应/SSE 字节流、时钟、随机种子）和输出（响应帧、chunk 序列、落盘文件、发出的上游请求）写成 `testdata/golden/<module>/<case>.json`。
2. **回放**：Go 侧 `go test ./... -run Golden` 用同样输入跑，上游用 httptest 回放录好的字节流，时钟/ID 注入同样的种子。
3. **比对**：JSON 规范化（键排序、去掉时间戳等白名单字段）后逐字段 diff；SSE 比对 chunk 顺序与边界；落盘文件比对路径 + 内容；对上游发出的请求比对 method/path/header 白名单/body。
4. **覆盖面**：契约层（359 过程的 input/output 校验，已有 TestContractParity）、gateway（每个 provider 的请求拼装、SSE 解析、错误映射、重试/冷却/超时）、工具循环（多步工具调用、并行、abort、错误回填）、存储（设置/历史/记忆的文件格式与路径）、CLI 驱动（行协议）、迁移（Electron 数据 → Go 首启）。
5. **CI**：Linux job 先跑 Node 录制（确定性 case 入库，变更时重录并在 PR 里显示 diff），三平台都跑 Go 回放；任何差异 = 失败，除非在 §3.4 登记。

## 3. 批次（按依赖顺序）

每批统一验收：① Go 单测 + 现有 TS 单测通过；② 契约一致性测试（该批过程的 zod 输入/输出 fixture 在 Go 端往返通过）；③ 真实应用中手测该批功能路径；④ `desktop-go.yml` 三平台 CI 绿。估时为一名熟悉代码的工程师 / 智能体的有效人日（含测试），不含评审等待。

| # | 批次 | 范围 | 主要 Go 库 | 额外验收 | 估时 |
| --- | --- | --- | --- | --- | ---: |
| 0 | 规划 + 脚手架（本批） | 计划文档、`apps/desktop-go` 骨架、CI | — | 骨架三平台可构建 | 已完成 |
| 1 | 契约生成 + 传输 + 路由骨架 | zod→JSON Schema→Go 类型生成器（CI 校验无漂移）、WS server、query/mutation/stream/事件、错误码、`dangerous`/`surfaces` 校验；未实现过程统一返回 `NOT_IMPLEMENTED` | `google/jsonschema-go` 或 `omissis/go-jsonschema`、`coder/websocket` | 359 过程全部注册；渲染进程连上不报错 | 4–5 |
| 2 | 外壳基础 | 窗口（对话 / 看板娘 / 岛）、托盘、资产协议+CSP、单实例、userData 路径、日志/诊断、theme/locale/startup/onboarding | Wails v3 | 三平台窗口与托盘可用；Mac 透明结论（§4.3） | 5–7 |
| 3 | 设置与存储 + 数据迁移 | 所有 JSON/TOML 存储原子读写、safeStorage 密文迁移、旧版目录探测 | `go-keyring`、toml | 用 2.0.4 真实 userData 快照升级后设置/历史/记忆不丢（自动化 fixture 测试） | 4–5 |
| 4 | Provider + 网关 | providers.*、gateway 四协议（Messages / Responses / Chat / Gemini）请求与流式互转、canonical IR、路由 / 冷却 / 限流 / 隐私、usage/quality；全部自研 | `net/http`、自写 SSE | 四协议对拍现有 TS 网关测试 fixture | 8–10 |
| 5 | AI 运行时 + MCP | 对话流（stream）、自研工具循环（多步、并行工具、中止，对齐 `streamText` 语义）、memory、tools、自研 MCP 客户端（stdio/HTTP/SSE） | 仅标准库 | 与 TS 版录制回放对拍；取消 < 200ms | 10–14 |
| 6 | 桌面工具 / 工作区 / 权限 | desktop.*、pathGuard（Win 长短路径）、PermissionBroker、Undo/Trash/Audit、文件解析 | `pdfcpu`/`ledongthuc/pdf`、`archive/*` | 复用现有 pathGuard 测试用例 | 6–8 |
| 7 | CLI 编排 + 终端 | harness（63）、cli/cliAccount/cliUpdate/delegate/agents/history、PTY、sqlite 只读 | `creack/pty`、ConPTY、`modernc.org/sqlite` | Win/Mac/Linux 各跑通 Codex/Claude CLI 一次会话 | 10–14 |
| 8 | 知识 / 本地 / 记忆 / 定时 / 扩展 | kb/mem/local/sched/ext/hub | `robfig/cron` | 定时任务跨重启 | 6–8 |
| 9 | 语音 + TTS | Edge TTS、Azure/OpenAI、系统 TTS、whisper.cpp、云 ASR；VAD/OCR/嵌入迁至渲染 WASM | websocket | 三平台播报 + 识别冒烟 | 5–7 |
| 10 | 看板娘 / 角色包 / 岛 / 截屏 / 剪贴板 / 通知 | mascot.*、window.*、character、persona、chatBg、island、screen、物理/穿透；SVG 默认 + Rive 开关 | `kbinani/screenshot` | §5 验收 | 5–7 |
| 11 | 更新 + 打包 + 签名 | Go 版自身更新检查（GitHub Releases，弹窗引导下载，不自动替换）、三平台安装包（dmg / nsis / AppImage+deb）、Mac Developer ID 签名；**不包含** Electron 2.0.4.x 线的弹窗改动（§0.2） | Wails packager | 首次启动迁移 Electron 数据（§4.5） | 4–6 |
| 12 | 收尾 | 删除 `host-electron` 与 Node 主进程代码、文档、CHANGELOG、E2E 迁移（Playwright → WebView 或 Go 驱动） | — | 全量 E2E 绿 | 4–6 |
| | **合计** | | | | **≈ 72–98 人日** |

依赖：1 → 2 → 3 →（4 → 5）∥ 6 ∥ 8 → 7（依赖 4/6）→ 9、10（依赖 2/3）→ 11 → 12。4/6/8/10 可并行。

## 4. 风险

### 4.1 Go 里没有 Vercel AI SDK 等价物（最高；已决定全部自研）
`streamText` 的多步工具循环、并行工具调用、`maxSteps`、流式 tool-call delta、Provider 差异抹平、`@ai-sdk/mcp` 都要自写或选框架。决定：不用任何 SDK，协议适配器、SSE 解析、tool loop、MCP 全自研（工作量计入批次 4/5，可能上浮 20–30%）。缓解：先把 TS 版的流事件录成 fixture，Go 版逐帧对拍。

### 4.2 PTY / 子进程
`creack/pty` 不支持 Windows，需 ConPTY 单独实现；Windows 路径（d511566c 修的长/短路径）要原样移植测试。

### 4.3 Mac 窗口透明（已知：白底）
Wails v3 Mac 透明需 `BackgroundType: Transparent` + `Mac.Backdrop`/`WebviewIsTransparent`，POC 未成功。若 v3.0.0 修不了：A) 在 `wailsshell` 用 cgo 直接设置 `NSWindow`/`WKWebView` `drawsBackground=NO`；B) 等上游修复；C) Mac 暂用不透明圆角卡片（体验降级）。阻塞看板娘，必须批次 2 内结论。

### 4.4 自动更新
electron-updater 不能用。需自建：GitHub Releases 清单 + sha256/签名校验 + Mac 替换 .app（未公证会被 Gatekeeper 隔离，需清 quarantine 或引导手动安装）+ Win 安装器静默升级 + Linux AppImage 自替换。**关键：已安装的 2.0.4（Electron）用户如何拿到 2.0.5**——electron-updater 会下载 2.0.5 的安装包，需让 2.0.5 产物满足旧 latest.yml 格式与安装器约定，否则用户需手动下载。

### 4.5 用户数据迁移
存储全是 JSON/TOML（无 DB），Go 版读写同一目录即可，但：
- userData 路径：Electron 在 Mac `~/Library/Application Support/<productName>`、Win `%APPDATA%\<productName>`、Linux `~/.config/<productName>`；**已改（D10）**：Go 版目录名 `Nomi`，首启从 Electron 目录复制，不再共用同一目录；
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

Q1–Q7 已决（§0.1）。新增待决：2.0.4 用户发现新版的渠道（§0.2）。
