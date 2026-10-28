# 测试

| 层级         | 位置                                       | 运行                   | 跑什么                                                                                                                                                        |
| ------------ | ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单元测试     | `packages/*/src/**`、`packages/*/tests/**` | `pnpm test`            | 各包逻辑；`core` 与 `host-electron` 用 Jest（`packages/{core,host-electron}/tests/unit`），其余包用 Vitest；跑完各包再跑脚本测试                              |
| 脚本测试     | `scripts/__tests__`                        | `pnpm test:root`       | 仓库级规则：changelog / changeset、发布与签名、electron-builder 配置、turbo 输入、品牌名、角色名扫描、语义事件名、体积预算                                    |
| 无界面 E2E   | `e2e/tests`                                | `pnpm test:e2e`        | 不启动 Electron：真实内核（`createCore`）跑在无界面宿主 `host-node` 上，视图侧客户端经 in-process / WebSocket 传输连进来，假 LLM 与测试工具装进内核的插件宿主 |
| 浏览器冒烟   | `scripts/dev-web/smoke.mjs`                | `pnpm smoke:web`       | ai-chat 开发页在 Playwright 的 Chromium 里经 WebSocket 连开发态内核（`pnpm dev:web`）                                                                         |
| 真实应用 E2E | `e2e-headed/tests`                         | `pnpm test:e2e:headed` | Playwright 启动真实 Electron，操作界面                                                                                                                        |

## 无界面 E2E（`e2e/`，Vitest，8 个文件 / 23 个用例）

每个用例用 `e2e/helpers/headlessCore.ts` 起一个真实内核：`@nomi-ai/host-node/core` 的 `startHeadlessCore()`（临时目录、
内存密钥、记录下来的对话框 / 通知 / 窗口调用），视图侧的 `ClientAIClient` 经 in-process 传输连进来（一个连接 = 一个窗口）。
内核的插件宿主里多一个探针插件（宿主钩子 `aiPluginsAfter`）：换上假 LLM、往真实工具表里加测试工具、拿插件上下文发插件事件。
`e2e/setup/isolateEnv.ts` 把 HOME、PATH 指到空目录，去掉环境变量里的供应商 Key，关掉离线 TTS 与首次引导，结果不随开发机变。

- `E1.companion-tts-lipsync`：TTS 分片（口型包络）与回合结束事件推给订阅了的窗口，没订阅的连接一帧都收不到
- `E2.chat-only-send-and-tool`：对话窗口经内核的外发检查发消息到假 LLM、工具执行事件、内置工具列表
- `E4.companion-profile-write-read`：用户画像（内核真实的 `UserPreferenceMemoryPlugin`）写入后推给多个窗口，下一次对话读到最新值
- `E5.write-file-confirm`：危险工具 `write_file` 需要确认，拒绝后不执行并返回 `E_TOOL_DENIED`
- `E6.core-twice`：同一进程里两个内核互不相干（服务、事件、router、AI runtime、主题 / 用户画像 / 网关供应商 / 记忆的数据与目录）；没有宿主片段时窗口过程 UNAVAILABLE
- `E7.websocket-transport`：WebSocket 传输对真实内核的握手、查询、修改与事件订阅；错 token 与外站 Origin 被拒绝
- `E8.stand-in-character`：替身角色验收（[内核宿主分离 §11.3](../design/core-host-decoupling.md)）的无界面部分：无界面宿主上的真实内核经内核选项 `builtinCharacterPack` 用 `characters/test-dummy` 作内置包（不靠 `CHARACTER_PACK` 环境变量），ai-chat 的真实 `SdkIPCClient` 经契约发给模型的系统提示、角色 preset 的身份段、发给界面的人设与角色包快照里都没有官方角色名
- `E9.avatar-semantic-events`：语义事件协议（[§10.5](../design/core-host-decoupling.md)）在真实内核上：`ctx.avatar`、工具 `avatar_gesture`、`ai.avatar.*` 与首次引导经内核事件总线发 `avatar.event`，只有看板娘窗口收到；资源名过不了线；看板娘窗口报的 `touched` 到 `ctx.avatar` 与订阅了的窗口

## 浏览器里的视图（`pnpm dev:web` / `pnpm smoke:web`）

```bash
pnpm build
pnpm dev:web                       # 内核在 Node 里跑（数据在临时目录），打开 http://127.0.0.1:6128
pnpm dev:web -- --data .nomi-web   # 数据放在指定目录，保留（已 gitignore；secrets 未加密）
pnpm exec playwright install chromium   # 第一次跑冒烟前
pnpm smoke:web [-- --screenshot test-results/dev-web.png]
```

- `dev:web`（`scripts/dev-web/start.mjs`）用无界面宿主起内核（统一网关在 Node 子进程里跑，监听系统分配的端口，不和本机装着的 Nomi 抢 18721），WebSocket 传输只监听 `127.0.0.1`、每次启动一个随机 token（日志只露前 4 位）、只接受开发服务器的 Origin；ai-chat 开发服务器把地址与 token 以 `window.nomiDevTransport` 注入页面，并把 CORS 收紧到自己的地址。没有窗口、托盘与看板娘，要用窗口对象的过程（看板娘大小、灵动岛、应用图标）报不可用。
- `smoke:web` 起同样的环境（空闲端口，不和正在跑的开发服务器冲突），用 Playwright 的 Chromium（不是 Electron）打开页面，断言页面渲染、没有未捕获异常、调用经 WebSocket 到了内核、内核里预设的主题与语言出现在页面上、内核换主题后页面跟着变；最后在页面的首次引导里添加指向本机假上游（OpenAI Chat 协议）的供应商、选模型、完成引导，发一条消息，回复经统一网关回到页面。
- 生产构建不含 WebSocket 传输：ai-chat 只在 `import.meta.env.DEV` 时读注入的全局，Vite 插件在构建产物里发现 WebSocket 传输就让构建失败。

## 真实应用 E2E（`e2e-headed/`，Playwright，45 个文件 / 56 个用例）

看板娘与内置角色诺米（E1、E4、E15、E22、E23）、对话与历史（E2、E6、E19）、MCP（E3）、整机冒烟（E5）、供应商与网关（E7、E26、E34）、互动（E9）、桌面能力（E10）、气泡安全与工具栏（E11、E12）、提醒 / 剪贴板（E13）、引导与语言（E14、E16）、编程助手（E17、E18、E20、E24、E25、E27、E29、E32、E33、E35、E36）、灵动岛（E21）、输入栏与启动视图（E28、E30）、图片主题（IMAGE）、设置布局（V111）、无障碍（A11Y）、快捷键与命令面板（KEYS）、英文界面（I18N）、性能（PERF）、界面截图（UI、ANIM）、替身角色（G5）。用 `pnpm exec playwright test --config playwright.config.ts --list` 看完整清单。

```bash
# 在仓库根目录运行，先 pnpm build（host-electron 的构建最后一步把两个视图复制进它的 dist）
xvfb-run -a pnpm test:e2e:headed     # macOS / Windows 不用 xvfb-run
```

`playwright.config.ts` 固定界面语言为中文（`CD_LOCALE=zh-CN`），默认关闭首次引导（`CD_ONBOARDING=off`），并关闭离线语音合成（`CD_TTS=off`）。除下面的替身用例外，所有用例都使用内置角色诺米（Rive，起不来时回退到分层 2D sprite），不下载任何测试模型。

`pnpm build` 之后 `packages/host-electron/dist` 就能直接运行：turbo 的 `@nomi-ai/host-electron#build` 依赖 renderer 与
ai-chat 的构建，最后由 `scripts/copy-renderer.js` 把它们复制到 `dist/renderer`、`dist/ai-chat`（缓存命中时一起恢复）。
只重建了某个视图（例如直接跑它的 Vite）时，再手动 `pnpm --filter @nomi-ai/host-electron copy-renderer`。

### 替身角色构建（G5）

`G5.stand-in-character` 只在**替身构建**上跑（官方构建上自动跳过）：用 `characters/test-dummy`（static 模式、
占位图、名字「小纸」/ Pip）构建整个应用，走一遍首次引导、对话、设置 → 通用与看板娘窗口，断言界面文本
（含 aria-label / title）没有官方角色名、该写角色名的地方是「小纸」，发给模型的系统提示是替身的身份。
判定规则与 `pnpm check:character-leak` 共用（`scripts/lib/characterLeak.mjs`）。

`pnpm check:character-leak`（`scripts/check-character-leak.mjs`，CI 的 quality 里跑）静态扫描源码、界面文案、
`packages/*/index.html` 与 `packages/*/public`、非官方角色包，指桌面角色的地方不得写死官方角色名（规则见
[内核宿主分离 §11.2](../design/core-host-decoupling.md)），允许清单里每一项都要写理由且必须命中。

```bash
pnpm build:stand-in      # = CHARACTER_PACK=characters/test-dummy pnpm build（跨平台写法）
pnpm test:e2e:headed e2e-headed/tests/G5.stand-in-character.headed.spec.ts
pnpm build               # 换回官方构建再跑其它用例（turbo 按 CHARACTER_PACK 分开缓存）
```

## 为什么是两套 E2E

两套测的是不同层，没有可以删掉的重复：

- `e2e/` 在进程内跑真实内核，用假的 LLM 与工具验证契约（事件名、推送范围、拒绝路径的错误码、多内核隔离、WebSocket 传输），结果确定、不需要网络与 Electron。这些断言在真实应用里拿不到（没有可控的模型输出），真实应用 E2E 也没有覆盖 `write_file` 拒绝路径和 TTS 分片广播。
- `e2e-headed/` 验证用户真正看到和操作的界面，需要 Electron 与显示环境，不能搬到无界面宿主：透明置顶的看板娘窗口与命中区、拖拽与窗口位置、托盘、灵动岛、preload 与 `nomiHost`（拖入文件）、系统对话框、全局快捷键、窗口截图（UI、ANIM）、打包产物的生产模式冒烟（E5）。
- 合并到同一个 Playwright 配置需要把 Vitest 用例改写为 Playwright 的 test/expect，收益只是少一个配置文件。
- CI 里无界面 E2E 每个平台 1–2 分钟，真实应用 E2E 5–9 分钟；分成两个 job 可以并行，先给出快速信号。

## 真实 CLI 一致性测试（`e2e-cli/`，`pnpm test:e2e-cli`）

假上游（按场景注入保活、缺字段、截断等毛病）→ 进程内网关 → 本机安装的 claude / codex / gemini / grok / dsh。没装的 CLI 自动跳过；每次运行用新的临时 HOME，不读写你自己的配置。

- `conformance.test.ts`：每个 CLI 用 Nomi 第三方会话同样的注入方式指向网关（Gemini 无界面运行要 `GEMINI_CLI_TRUST_WORKSPACE=true`），断言毛病流经网关后能正常答完、上游中途断开时 CLI 报错而不是空回复。
- `modelSwitch.test.ts`：真实编排器 + 真实 `GatewayService`（网关进程入口 `core/src/gateway/worker.ts` 在测试进程里跑，编排器的网关依赖就是应用里用的 `harnessGateway`），断言第三方标签换模型后上游实际收到的模型：A → B → A、进行中换模型下一轮生效、空闲回收后保持并续接，每一轮的全部请求（含辅助请求）都是标签当时选的模型。`NOMI_E2E_SWITCH_REPORT=<文件>` 写出每轮请求数。
- `probe.test.ts`（`NOMI_E2E_PROBE=1` 才跑，很慢）：直接对着 CLI 逐个删字段、注入未知事件，得出「这个版本要求什么」，与 `snapshots/<cli>-<版本>.json` 比对。本机版本没有快照时跳过比对并说明；`NOMI_E2E_PROBE_UPDATE=1` 写入快照（人工看过差异再提交）。Grok 按它报的 `missing field` 读必填字段；其余 CLI 看删掉字段后还能不能答出（删掉正文本身的字段必然「必填」，快照只用来发现变化）。
- 夜间 CI：`.github/workflows/e2e-cli-nightly.yml` 每天从 npm 装最新版 CLI 跑一遍（不需要 secret）；手动触发可打开探测，`update_snapshots` 会把新版本的快照作为 artifact 上传。

## 网关回放夹具（`packages/gateway/tests/fixtures/replay/`）

把真实遇到的第三方上游问题固化成回归测试：诊断日志打开时网关会写追踪文件（`userData/gateway/trace/*.json`，含入口请求体、上游原始响应全文、给客户端输出的差异），用脚本转成脱敏夹具：

```bash
pnpm -F @nomi-ai/gateway exec tsx scripts/trace-to-fixture.ts <trace.json>... [--name 名字] [--keep-text]
```

- 默认去掉对话正文（正文类字段的非空字符串换成 `[text]`，结构不变；空字符串保留，保活靠 `delta: ''` 识别），并再脱敏一遍；不带任何请求头。工具参数（`arguments`、`partial_json`、参数对象）保留，里面可能有文件内容，**提交前自己看一遍**。`--keep-text` 保留正文（只用于本地排查，不要提交）。
- 回放的是最后一次上游尝试；SSE 按事件切块逐块写出，截断在半截的事件原样保留（其中的正文字符串同样换掉）。
- `tests/replay.test.ts` 对每个夹具：起一个按块回放的假上游，经 `createGateway` 发出录下的请求，断言给客户端的输出通过入口协议的规范校验（`src/spec`）、以结束或失败事件收尾，并对去掉 id / 时间戳的事件做快照；提交前就失败的（一个内容事件都没有）断言是 HTTP 错误。
- 仓库里现有的 4 个夹具是用已有测试场景合成的（`"synthetic": true`），不是真实流量。

## 性能基准与体积预算

先 `pnpm build`，Linux 无显示器时前面加 `xvfb-run -a`：

```bash
node scripts/measure-session-switch.mjs [--scenario nomi|cli] [--cpu 4]   # 切换会话：点击 → 内容绘制耗时、长任务、主线程脚本 / 布局
node scripts/measure-stream-render.mjs [--chars 8000] [--cps 320]         # 流式输出长代码块：主线程忙碌占比、渲染次数
node scripts/check-bundle-budget.mjs [--strict]                           # 首屏 JS / CSS 体积预算（scripts/bundle-budgets.json）
```

体积预算按 `dist/index.html` 的入口 script + modulepreload + stylesheet 统计，并禁止语法高亮器出现在首屏 chunk。CI 里只报告（`::warning` 注解 + job summary，`continue-on-error`），不会变红；加 `--strict` 才失败。调高预算要在 PR 里写明原因。

## CI

`.github/workflows/ci.yml`（什么事件跑哪些 job 见 [CI 触发规则](ci.md)：普通 PR 只跑 Linux quality + changeset，带 `ci:full` 标签才跑完整矩阵）：

- `quality`（Ubuntu / Windows / macOS）：许可、i18n、角色名扫描（`check:character-leak`）、typecheck、lint、单元测试、构建；Ubuntu 上追加首屏体积预算报告（不阻塞）
- `e2e-headless`、`e2e-headed`（Ubuntu / Windows）；`e2e-headless` 在 Ubuntu 上追加浏览器冒烟（`pnpm smoke:web`）
- `dev-smoke`（Ubuntu）
- `changeset status`
- `build-electron`（三平台打包）

`.github/workflows/e2e-cli-nightly.yml`：定时 + 手动，真实 CLI 一致性测试（见上），不在 push / PR 上跑。

编程助手编排的单测（`packages/core/tests/unit/cli/CliHarness.*.test.ts`）每个用例都起假 CLI 进程：等进程里发生的事要用 `tests/helpers/wait.ts` 的 `until`（按条件等，带说明的超时），不要数固定次数的轮询或断言墙钟耗时；轮询读假 CLI 的日志时容忍写到一半的末行。全量测试并行负载下进程启动可能要好几秒。
