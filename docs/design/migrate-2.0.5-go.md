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
| D7 | node-pty | Go PTY（creack/pty + Windows ConPTY） | 平台库不同，读写/尺寸/退出码语义对齐 |
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
| D19 | 复读检测/正文工具调用按 JS 字符串语义（UTF-16 长度、Unicode `\s`、`trim`） | Go 用 `util.JSTrim/UTF16Len/UTF16Tail` 还原；截取尾部时若正好切在 emoji（代理对）中间，Go 保留整个字符（JS 会留半个） | Go 字符串是 UTF-8，无法表示半个代理对；只影响内部缓冲，输出不变 |
| D20 | GLM 参数名若是纯数字（如 `"1"`），JS 对象会把它排到最前 | Go 有序对象按出现顺序 | 极少见的边角情况，暂不模拟 |
| D21 | 上游地址用 WHATWG `new URL` 解析（会把 `0x7f.1` 之类主机名规范成 `127.0.0.1`） | 用 Go `net/url` 解析，主机名原样保留 | 校验函数本身按宽松写法识别各种 IPv4 写法，分类结果一致；只有报错文案里的 host:port 写法可能不同 |
| D22 | 出站走 undici：有代理时用 EnvHttpProxyAgent（含 `ALL_PROXY`），钉 IP 靠 AsyncLocalStorage | Go `http.Transport`：代理用 `http.ProxyFromEnvironment`（不认 `ALL_PROXY`），钉 IP 靠请求 context，只对目标主机生效，连代理本身时按校验规则现查 | Go 标准库没有 ALL_PROXY；按 context 钉 IP 更直接，安全性等同 |

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
