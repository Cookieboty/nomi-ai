# 编程助手接入：监视升级、会话接管与供应商切换（设计稿）

> 状态：**P0 实现中 / 已批准**（2026-10-14）。
> 关联：现有 [编程助手监视](agent-monitor.md)、[供应商与 Token](providers.md)、[AI 对话](chat.md)。

## 1. 产品一句话

把 Nomi 的对话窗口做成 **Claude Code / Codex（及后续同类 CLI）的 UI 外壳**：消息、工具确认、权限与进度都转发到本机真实 CLI；同时提供 **版本检查与看板娘一键更新**，以及 **按工具独立切换 API 供应商**（含可选本机协议路由）。Nomi 自己的 AI 运行时仍保留为「Nomi 原生」后端，可随时切回。

## 2. 现状（代码事实）

| 能力         | 现状                                                                                                                                     | 缺口                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 编程助手监视 | `AgentProgressService` 只读解析 `~/.claude`、`~/.codex`、Cursor 等本地会话 + 进程存活；设置 → 编程助手 →「监视与会话」标签展示与气泡提醒 | 无版本号、无安装路径、无更新动作                               |
| 对话后端     | 固定走 `AIClient` → `ai-runtime`（Vercel AI SDK + ProviderStore）                                                                        | 无法把一轮对话交给外部 CLI                                     |
| 供应商       | Nomi 自己的 `ProviderStore`（safeStorage、任务路由、多 Key）                                                                             | 不写 `~/.claude/settings.json` / `~/.codex/config.toml`        |
| 本地模型     | 本机管理面板 + llama.cpp / Ollama 标签                                                                                                   | 可作无云 Key 的联调，与 CLI `--oss` / 第三方 base URL 尚未打通 |

**设计原则（不可破）：**

1. **真实 CLI 做智能与工具** —— 接管模式下 Nomi 不复刻 Claude Code / Codex 的 agent loop，只做 UI + 进程桥 + 配置桥。
2. **最小改写配置** —— 供应商切换只替换连接字段（endpoint / key / model / 协议），保留用户自有 hooks、MCP、权限、注释。
3. **权限在工具侧** —— Bash / 写文件等确认优先走 CLI 自己的 permission 事件；Nomi 只渲染并回传用户选择。
4. **可回退** —— 任意时刻切回「Nomi 原生」；切换或更新失败不破坏原配置（先备份）。

## 3. 外部能力调研摘要（2026-10）

### 3.1 Claude Code（`@anthropic-ai/claude-code`，npm latest ≈ 2.1.299）

- **无界面可编程**：`claude -p`；流式用 `--output-format stream-json --verbose [--include-partial-messages]`；多轮 stdin 用 `--input-format stream-json`。
- **会话**：`--resume <sessionId|jsonl路径>` / `--continue`；会话落在 `~/.claude/projects/<cwd编码>/<id>.jsonl`（与现监视器一致）。
- **权限**：`--permission-mode`、`--allowedTools`、`--permission-prompts`；stream-json 可出现待确认事件，适合 UI 转发。
- **供应商环境**：官方与社区实践通过 `~/.claude/settings.json` 的 `env`（如 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`）热切换；Claude Code 支持热重载，一般**不必重启**。
- **更新**：`claude --version` / `claude doctor` / `claude update`；npm 安装用 `npm i -g @anthropic-ai/claude-code@latest`（勿用 `npm update -g`）。

推荐接管实现：**长期存活的 `claude -p --input-format stream-json --output-format stream-json --verbose` 子进程**，按会话绑定 cwd；权限回调映射到 Nomi 气泡 / 详情对话框。可选后续再评估官方 Agent SDK（TS/Python）作为同协议的替代宿主。

### 3.2 Codex CLI（`@openai/codex`，npm latest ≈ 0.162.1）

- **无界面**：`codex exec`（别名 `e`）+ `--json` → NDJSON（`thread.*` / `turn.*` / `item.*`）。
- **会话**：`codex exec resume [--last|--all] [SESSION_ID]`；磁盘 `~/.codex/sessions/.../rollout-*.jsonl`（监视器已解析新/旧格式）。
- **本地模型**：`--oss` + `--local-provider ollama|lmstudio` —— **无云 Key 联调的首选**。
- **配置**：`~/.codex/config.toml` + `auth.json`；切换供应商后多数情况需**重启终端 / daemon**。
- **更新**：`codex update`（发行版自更新）；另可用 npm / 官方安装器。

推荐接管实现：优先 **`codex exec --json` 单轮 + resume 续聊**（实现简单、事件模型清晰）；P1 再评估 `codex app-server`（stdio/WS）做真正的长连接 UI。

### 3.3 Grok Build（`@xai-official/grok`）

详见 [cli-harness-grok.md](cli-harness-grok.md)：headless `-p` + `streaming-json`；供应商写 `~/.grok/config.toml`（`api_backend`）；用量读 `updates.jsonl` 的 `turn_completed`；订阅额度暂不支持。

### 3.4 Cursor Agent CLI

- 存在 headless：`agent -p` / `--print`，`--output-format text|json|stream-json`，`--resume`。
- 鉴权偏 `CURSOR_API_KEY`；会话存储仍为私有 SQLite（监视器只靠 mtime + 进程）。
- **P0/P1 不纳入「完整接管」**，仅保留监视 + 版本检测；P2 再评估。

### 3.5 CLI 供应商与本地路由（Nomi 自建）

| 概念               | 含义                        | Nomi 实现                                                                                                   |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 按工具的供应商档案 | Claude / Codex 各自一组档案 | `userData/cli-providers/claude/store.json` 与 `…/codex/store.json`，与 Nomi 原生 ProviderStore **完全隔离** |
| 一键启用           | 只改连接字段，备份后写回    | 原子写 + `userData/cli-providers/backups/`                                                                  |
| Direct             | CLI 直连上游（原生协议）    | 默认：Claude=`anthropic_messages`；Codex=`openai_responses`；dsh=`openai_responses`                         |
| 本地路由           | 本机代理做协议转换          | `CliRouteService` 监听 `127.0.0.1:18721`；非原生格式须开启路由后才能启用档案                                |
| Aggregation        | 多上游模型列表合并          | **P2**                                                                                                      |
| Apps 页升级        | 检测版本、安装、升级        | 对标「版本与更新」章节，由看板娘执行                                                                        |

**上游格式（按 CLI 不同）：**

- **Claude Code**：原生 Anthropic Messages；OpenAI Chat Completions / Responses / Gemini 需本地路由转换。
- **Codex**：原生 OpenAI Responses；Chat Completions / Anthropic Messages 需本地路由转换。
- **dsh**：新建默认 OpenAI Responses；内置适配器另原生支持 Chat Completions / Anthropic Messages，均无需本地路由。

**经本地路由接本机 Ollama（实测 2026-10）：**

- Ollama 默认上下文约 2k token，而 Claude Code 每轮系统提示 + 工具定义约 16k token，超出部分会被**静默截断**，表现为空回复或答非所问。
- 启动 Ollama 时设置 `OLLAMA_CONTEXT_LENGTH=20480`（或更大）：`OLLAMA_CONTEXT_LENGTH=20480 ollama serve`；Codex 的提示约 6k token，同样建议 ≥ 8192。
- 档案的 API 地址填 `http://127.0.0.1:11434/v1`，格式选 OpenAI Chat Completions，开启路由并接管对应 CLI。

## 4. 用户体验

### 4.1 对话窗口：后端切换器

在现有「供应商 / 模型」旁增加 **后端** 下拉：

| 后端             | 行为                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Nomi**（默认） | 现状：AIClient + 自有工具（知识库、记忆、桌面能力…）                                       |
| **Claude Code**  | 本会话所有用户消息 → Claude CLI；工具与权限 UI 显示 CLI 事件；Nomi 自有 agent 工具默认关闭 |
| **Codex**        | 同上，走 `codex exec`                                                                      |

附加控件：

- **工作目录**：默认当前项目（可浏览）；与 CLI `--cd` / 启动 cwd 一致。
- **接管已有会话**：从监视器列表选一条 Claude/Codex 会话 → `--resume` / `exec resume`，聊天区加载只读历史摘要 + 可续写。
- **CLI 供应商**：仅在 Claude/Codex 后端显示；切换即写对应配置（见 §5）。

看板娘：切换后端时短提示；CLI 报错 / 等待权限时气泡同步。

### 4.2 版本检查与更新（看板娘）

入口：设置 → 编程助手 → 对应端点（Claude Code / Codex / dsh）顶部的「版本」卡片；托盘「编程助手」；Nomi 气泡「发现更新」。

对每个已检测工具卡片展示：`已安装版本` · `最新版本` · `安装方式`（npm / 原生 / homebrew / 未知）· `路径`。

操作：

1. **检查更新**（可定时，默认每天一次，可关）。
2. **更新** → 二次确认（显示将执行的命令）→ 主进程跑更新 → 进度与结果通过气泡 + 面板展示。
3. 失败保留日志路径；不自动 `sudo`。

版本源：优先 CLI 自带（`claude update` / `codex update` / `claude --version`）；否则 npm registry `latest`；Homebrew 提示用户在终端执行（Nomi 不静默改 brew）。

### 4.3 CLI 供应商切换与本地路由

设置 → **「编程助手」** 页（见 §13.4 与 §14：一个页面，顶部按端点切换，Nomi / Claude Code / Codex / dsh 各自独立，外加「监视与会话」）：

- 分栏：按端点（Claude Code | Codex | dsh）。
- 档案列表：名称、base URL、model、**上游格式**、启用态；Key 走 **同一套 safeStorage**，不入明文 JSON。
- 预设：Anthropic 官方、OpenAI 官方、OpenRouter、DeepSeek、硅基流动、自定义……（可从 Nomi 已有 presets 映射）。
- **启用**：备份 → 写 `~/.claude/settings.json` env 或 `~/.codex/config.toml` + auth 字段 → Claude 热生效；Codex 提示重启。
- **开启路由**：高级设置开关；开启后非原生格式档案可启用，CLI 配置写入本机路由地址与占位 Key，真实上游由路由转发并转换协议。
- **从 Nomi 导入**：把原生供应商的 baseURL/model/key 复制为 CLI 档案（用户确认）。

Aggregation（多上游合并）仍为 **P2**。

## 5. 架构

```
┌─ ai-chat ─────────────────────────────────────────────┐
│  BackendSwitcher │ CliProviderSwitcher │ Chat transcript │
│  PermissionCard  │ ToolCallTimeline（只读渲染 CLI 事件） │
└────────────┬──────────────────────────────────────────┘
             │ IPC  ai:harness:*  /  ai:cli-provider:*  /  ai:cli-update:*
┌────────────▼──────────────────────────────────────────┐
│ electron 主进程                                        │
│  CliHarnessService     子进程生命周期、stream 解析、会话表  │
│  CliProviderBridge     读写 ~/.claude / ~/.codex（原子+备份）│
│  CliUpdateService      which/version/latest/更新命令      │
│  AgentProgressService  现有监视（扩展 version 字段）       │
└────────────┬──────────────────────────────────────────┘
             │ spawn
     ┌───────┴────────┐
     │ claude -p …    │  codex exec --json …
     └────────────────┘
```

**进程模型：**

| 后端        | 进程策略                                                                                                                                                                                                                                                                                                                            | 输入                                 | 输出               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------ |
| Claude Code | **会话级长驻**：每标签一个 `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio` 子进程（cwd 固定）；多轮向 stdin 写 user NDJSON，等 `result` 后**不**关 stdin；换 cwd / 后端 / 关标签 / 取消当前轮时拆除。进程异常退出则下一轮带 `--resume` 重拉（明确降级，非「永不掉线」） | stdin NDJSON user / control_response | stdout stream-json |
| Codex       | 每用户消息一次 `exec --json`（或 `exec resume`）；P1 可升 app-server                                                                                                                                                                                                                                                                | argv / stdin prompt                  | stdout NDJSON      |
| Nomi        | 无外部进程                                                                                                                                                                                                                                                                                                                          | —                                    | AIClient 事件      |

**Claude 长驻说明（2026-10-15 对照 CLI 2.1.299）：**

- 官方 print 模式支持 `--input-format stream-json` 保持 stdin 打开跨多轮；会话身份在启动时用 `--resume` 绑定，中途不能换会话（见 anthropics/claude-code#84060）。
- Nomi 实现为**会话级进程复用**（一标签一进程），不是全局单例 daemon；中断发 `control_request{subtype:interrupt}` 后 `SIGKILL`，下一轮 `--resume`。
- 若本机 Claude 在 stream-json 下仍每轮退出：harness 会在下一发送时自动重拉并带 `--resume`，功能不丢，只是少了「免冷启动」；以 mock 单测断言「同一 pid 跨两轮」为回归护栏。

**权限桥：** Claude Code 使用 `--permission-prompt-tool stdio`：`control_request`（`can_use_tool`）→ IPC → 对话区允许/拒绝卡片 → `control_response` 写回 stdin；120s 无操作自动拒绝。长驻模式下权限通道与多轮共用同一 stdin。

**Codex 交互权限（查证 2026-10-15，CLI 0.162.1）：**

- `codex exec --json` 的 NDJSON 事件为 `thread.*` / `turn.*` / `item.*` 等，**没有**可回写的交互式 approval / permission 事件；`--approve-for-me` 为自动审批，`--dangerously-bypass-approvals-and-sandbox` 为跳过，均非 UI 桥。
- 交互式审批存在于实验性 **`codex app-server`**（JSON-RPC：`ExecCommandApproval*` / `CommandExecutionRequestApproval*` / `FileChangeRequestApproval*` 等），**不属于**当前 P0 的 `exec` 路径。
- **结论：P0 不对 Codex 做假权限 UI**；dsh headless 同样自行决策。看板娘气泡提醒仍走监视器完成/失败通道。P1 若接 app-server 再对标 Claude 权限桥。

**安全：**

- 子进程 `env` 显式构造；不把 Nomi 的全部 process.env 泄漏给 CLI（尤其是无关 Token）。
- 工作目录必须是用户选出的真实路径；拒绝 `..` 逃逸。
- 更新命令白名单：`claude update`、`npm install -g @anthropic-ai/claude-code@latest`、`codex update`、`npm install -g @openai/codex@latest`；禁止任意 shell 字符串。
- 写 `~/.claude` / `~/.codex` 前复制到 `userData/cli-providers/backups/<ts>/`。
- 接管模式关闭 Nomi 桌面写权限工具，避免双通道改同一仓库（开放问题可改为「询问」）。

## 6. 数据与迁移

| 数据                                      | 位置                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| 后端偏好、每会话 backend/cwd/cliSessionId | `userData/harness/sessions.json` + 对话元数据字段                              |
| CLI 供应商档案（无明文 key）              | `userData/cli-providers/claude/store.json`、`…/codex/store.json` + safeStorage |
| 配置备份                                  | `userData/cli-providers/backups/`                                              |
| 本地路由设置                              | `userData/cli-providers/routing.json`                                          |
| 更新缓存（latest 查询）                   | `userData/cli-update/cache.json`                                               |

迁移：无破坏性变更；首次打开 CLI 后端时引导「选择工作目录 + 检测 CLI 是否安装」。不自动修改用户全局 git / npm 配置。

## 7. 测试计划

| 层级               | 内容                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| 单元               | stream-json / NDJSON 解析；配置补丁；Claude/Codex **分店**；上游格式与路由开关；协议转换 transforms   |
| 集成（本地）       | **Mock CLI** 可执行文件（打印固定 NDJSON）—— CI 主路径                                                |
| 集成（本机有 CLI） | 真实 `claude` / `codex` smoke（需用户 Key 或登录）                                                    |
| **无云 Key**       | `codex exec --oss --local-provider ollama` + 本机 Ollama 模型；Nomi 原生后端继续用 Ollama / llama.cpp |
| E2E headed         | 后端切换器可见；选 Mock 后端发一条消息出现工具时间线；权限卡允许/拒绝                                 |
| 回归               | 监视器、Nomi 原生对话、ProviderStore 不受影响                                                         |

## 8. 里程碑建议

### P0 —— 可演示的「外壳 + 更新」（约 1.5–2.5 周）

1. `CliUpdateService`：检测 Claude Code / Codex / Cursor（能 which 到的）版本与 latest；面板 + 看板娘「更新」白名单命令。
2. 对话 **后端切换器**：Nomi | Claude Code | Codex。
3. Claude / Codex **新会话** 转发（Mock CLI 保证 CI；真实 CLI 手册验收）。
4. 权限/工具事件的最小 UI（列表 + 允许/拒绝）。
5. **CLI 供应商切换**（分店 Claude/Codex + 上游格式）+ 备份；**本地路由**（非原生格式）。
6. 设计文档定稿进 `docs/features/`（本文）；`agent-monitor.md` / `chat.md` 增加入口链接。

### P1 —— 接管与本地闭环（约 2–3 周）

1. 从监视器 **Resume 已有会话**。
2. Codex `--oss --local-provider ollama` 一键联调；文档化 Ollama 要求。
3. 流式 token / 工具时间线打磨；失败重试与「在终端打开」。
4. 路由故障转移 / 多上游；流式转换打磨。
5. Windows 路径 / 无登录体验。

### P2 —— 扩展（择优）

- Cursor `agent` 接管；Gemini CLI。
- Aggregation；用量展示；多会话并行。
- Claude Agent SDK 替换裸 spawn（若 CLI 协议不稳定）。

## 9. 明确不做（本阶段）

- 在 Nomi 内复刻 Claude Code / Codex 的完整 agent 运行时。
- 静默调用 `sudo` / 无人值守改系统目录。
- 把用户 CLI 的 OAuth 登录态上传或同步到云端。
- P0 实现多上游 Aggregation / 故障转移（本地直连转换已纳入）。
- 未批准前的任何功能实现提交。

## 10. 已拍板（2026-10-14）

1. **写配置前自动备份**（不依赖第三方工具检测）。
2. **登录**：仅 API Key / 已有登录态；**不在 Nomi 内做 OAuth**。
3. **CLI 模式**：禁用 **全部** Nomi 工具。
4. **默认后端**：保持 **Nomi**。
5. **更新范围**：~~Claude Code + Codex；Cursor 仅检测~~ → 2026-10-15 验收后改为 **Claude Code + Codex + dsh 都可检测、安装、更新**（见 §14.2）；Cursor 仍**仅检测**。
6. **工作目录**：对话级绑定（P0 用全局 harness cwd + 选目录按钮）。
7. **三套供应商隔离**：Nomi `ai-providers.json`｜Claude CLI 档案｜Codex CLI 档案；各写各的路径。
8. **本地路由**：非原生上游格式须「开启路由」后才能启用。

## 11. 批准后的首个实现切片（仍等批准）

1. `CliUpdateService` + 面板只读版本行（无更新按钮也可先合入）。
2. Mock `claude`/`codex` + harness IPC + 后端下拉空壳。
3. 单测覆盖解析与配置补丁。

---

_调研来源：本仓库 `packages/electron/src/agents/*`、官方 Claude Code headless/CLI 文档、OpenAI Codex CLI reference、Cursor headless CLI 文档（2026-10）。_

## 12. 第三个接管端点：dsh + 多标签并发后端（设计稿，2026-10-15）

### 12.1 dsh 调研摘要（`@deepseek-ai/dsh`）

| 项目     | 事实（2026-10-15 实测）                                                                                                                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm 版本 | `latest` / `next` = `0.2.0-rc.2`，`alpha` = `0.2.1-alpha.3`；bin 为 `dsh`                                                                                                                                                                                                        |
| 运行时   | **需要 Node ≥ 24**（使用 `import.meta.main`）；Node 22 下不报错、无输出、退出码 0，因此探测时要把「`--version` 无输出」视为运行时过旧                                                                                                                                            |
| 版本     | `dsh --version`                                                                                                                                                                                                                                                                  |
| 更新     | 无自更新命令，使用 `npm i -g @deepseek-ai/dsh@latest`；插件使用 `dsh plugin --profile <name> <pnpm 参数>` 管理                                                                                                                                                                   |
| 无头运行 | `dsh --profile headless --json [--session-id <id>] "<任务>"`；任务写 `-` 时从 stdin 读取                                                                                                                                                                                         |
| 事件流   | NDJSON：`session{sessionId,cwd}`、`status{phase:turn_start/step_start/step_end/turn_end, usage, reason}`、`text`、`thinking`、`tool_call{callId,tool,input}`、`tool_result{callId,status,result}`、`final{text}`、`error{message}`；文本按「已提交的步骤」整段输出，不是逐 token |
| 退出码   | 0 = 完成；1 = 中止或出错                                                                                                                                                                                                                                                         |
| 续接     | `--session-id session-<uuid>`；必须在同一 cwd 下运行，未知 id 会报错                                                                                                                                                                                                             |
| 其它模式 | `--profile acp`（stdio 上的 ACP）、`--profile sdk`（stdio JSON-RPC），留待 P2                                                                                                                                                                                                    |
| 配置根   | `DSH_HOME`（默认 `~/.dsh`）：`profiles/<name>/`、家目录级补丁 `cordis.patch.yml`、凭据 `.credentials.yaml`                                                                                                                                                                       |
| 会话存储 | `$DSH_HOME/sessions/<编码后的 cwd>/session-<uuid>/{session.lock, session.v4.jsonl.zstd}`；运行中的会话持有 `session.lock`                                                                                                                                                        |
| 供应商   | 默认使用 DeepSeek 官方接口（`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`）；内置适配器原生支持 `openai-completions`、`openai-responses`、`anthropic-messages`，**不需要本地路由**                                                                                                    |

### 12.2 dsh 供应商档案（第 4 套档案库）

- 档案库位于 `userData/cli-providers/dsh/store.json`，与 Nomi / Claude / Codex 的档案相互隔离。
- 启用档案时，在 `$DSH_HOME/cordis.patch.yml` 中写入一段带 `# >>> nomi managed (dsh provider) >>>` 标记的区块，其余内容原样保留，并且先备份再原子写入：

```yaml
- id: llm-pi-ai
  config:
    providers:
      nomi:
        api: openai-completions # 或 openai-responses / anthropic-messages
        baseURL: https://example.com/v1
        apiKeyEnv: NOMI_DSH_API_KEY
        models:
          - id: <model>
- id: agent-default-model
  config:
    provider: nomi
    model: <model>
```

- **密钥不落盘到 dsh 配置**：由接管服务在启动 dsh 时注入环境变量 `NOMI_DSH_API_KEY`。用户在终端里自己运行 dsh 时，需要自行导出该变量，或停用档案、回到 dsh 默认供应商。
- 停用档案时只移除标记区块。

### 12.3 接管适配器

- 启动 `dsh --profile headless --json [--session-id <id>] <prompt>`，stdin 立即关闭，cwd 为会话目录。
- 事件映射：`text`/`final` → 文本；`tool_call` → 工具开始；`tool_result` → 工具完成或出错；`error`、`status.reason.kind=error` → 错误；`session.sessionId` 写回会话状态，供下一轮续接。
- 测试和 Mock 使用 `NOMI_DSH_BIN` 覆盖可执行文件，Mock 脚本为 `scripts/mock-cli/mock-dsh.mjs`。
- 版本检查和更新复用 `CliUpdateService`，类型为 `dsh`，安装方式固定为 npm。

### 12.4 多标签并发后端（已实现）

- **标签 = 会话**：每个标签绑定 `{backend, cliSessionId, cwd}`，互不阻塞。`CliHarnessService` 维护 `Map<tabId, 标签状态>`，每个标签同一时刻最多一个子进程。
- **Nomi 只在主标签**：主标签（`id = main`）即原有对话，后端可选 Nomi 或任一 CLI；新建的标签只能绑定 Claude Code / Codex / dsh。原因：Nomi 的对话历史、模型选择与工具状态由 `AiChatContext` 单例管理，只有一条「当前对话」，多个 Nomi 标签会互相覆盖；CLI 的会话由各自的 CLI 持久化，天然可多开。
- **并发上限**：全局信号量，默认 3（可调 1–8，`ai:harness:set-max-concurrent`）；超出的轮次状态为 `queued`，有空位时按先来先到开始运行。标签栏右侧显示「运行 x/上限 · 排队 n」。
- **状态与未读**：状态点 灰 = 空闲 · 蓝（脉动）= 运行中 · 黄 = 排队 · 红 = 出错 · 绿 = 有未读结果；标签不在前台（或窗口无焦点）时完成一轮，未读数 +1，切换过去即清零。关闭运行中的标签会先确认并终止子进程；切换后端或 cwd 会丢弃该标签的 `cliSessionId`。
- **快捷键**（Mod = macOS ⌘ / 其它 Ctrl，可在设置 → 快捷键改绑）：

  | 操作                     | 默认                      |
  | ------------------------ | ------------------------- |
  | 新建标签（弹出后端菜单） | Mod+T                     |
  | 关闭当前标签             | Mod+Shift+W               |
  | 下一个 / 上一个标签      | Ctrl+Tab / Ctrl+Shift+Tab |
  | 重命名当前标签           | Mod+Shift+R（或双击标签） |
  | 跳到第 1–9 个标签        | Mod+1 … Mod+9             |

  另外：中键关闭标签，标签获得焦点时 ←/→ 切换。

- **持久化**（均在 `userData/harness/` 下）：主标签 `session.json`（后端、cwd、会话、标题；消息仍走 Nomi 历史）；其它标签 `tabs.json`（`activeTabId`、`maxConcurrent`、标签元数据）与 `tabs/<tabId>.json`（消息，最多 300 条）。重启后被中断的运行回到空闲。
- **看板娘监视器**：一个列表聚合所有端点，按最近活动排序：
  - Claude Code：`~/.claude/projects/*/*.jsonl`
  - Codex：`~/.codex/sessions/**/rollout-*.jsonl`
  - dsh：`$DSH_HOME/storages/session_projcache/sessions/<id>.json` 取标题与 cwd；`session.lock` 运行结束后仍存在，所以「运行中」以内核 flock 是否被持有判断（Linux 读 `/proc/locks`，其它平台退回进程扫描 + 修改时间）。
  - Nomi 标签：实时状态优先于文件推断；由标签驱动的 CLI 会话不会在文件来源里重复出现。
  - 顶部按端点筛选（全部 / Nomi 标签 / dsh / Codex / Claude Code），标签条目有「打开标签」按钮直达。
- **提醒**：后台端点完成或需要处理时，看板娘说一句并做动作（成功挥手、失败思考），灵动岛显示带端点徽标与状态图标（完成 / 失败 / 需要处理 / 运行中）的事件。

### 12.5 普通 / 开发模式、端点隔离与分叉（HIGHLIGHT）

- **对话模式**（顶栏左侧「普通 | 开发」，默认普通，localStorage `ai-chat:chatMode`）：
  - **普通**：仅 Nomi。隐藏标签栏、后端切换器、Mod+T 等编程助手 chrome。后台 CLI 标签继续跑，模式控件显示「N 运行中」徽标；切回开发恢复标签栏与未读。
  - **开发**：完整 chrome。选中 / 新建非 Nomi 会话会打开或聚焦对应 CLI 标签；Nomi 会话始终走主标签 + nomi 后端。
- **会话归属**：每条 ConversationStore 元信息带 `backend: nomi|claude|codex|dsh` 与可选 `tabId`。旧行迁移为 `nomi`。侧栏列表不再混合身份——点 Nomi 只加载 Nomi；点 Claude 只聚焦该 Claude 标签。
- **CLI 标签进侧栏**：创建 / 重命名 / 关闭 / 消息时同步一条 ConversationStore 元信息（消息仍在 `userData/harness/tabs/<id>.json`）。删除侧栏项会关闭对应标签（运行中仍走原确认）。
- **切换后端**：有消息的会话不会静默改写身份。BackendSwitcher 会为新后端新建会话 / 标签；空会话可原地切换。跨端复制历史请用分叉。
- **侧栏视图**（「全部 | 按端」，持久化）：
  - 全部：所有会话 + 端点色标（与灵动岛一致：nomi 珊瑚 / claude 橙 / codex 蓝 / dsh 蓝紫）。
  - 按端：先选端点芯片（未安装的 CLI 禁用），再只看该端。
  - 「新对话」：普通 → 总是 Nomi；开发 + 按端 → 当前端；全部 → 弹出端点菜单。
- **分叉**（侧栏右键 / Mod+Shift+F）：
  1. **分叉为新对话**：同端复制可见消息，标题「原标题 (副本)」。
  2. **分叉到其他端**（仅开发模式）：选目标端；复制 user/assistant 文本（工具调用压成短注）。CLI 目标写入 seed 转录或 preface，**不声称跨 CLI resume**。
- **已知取舍**：主标签在开发模式下切到 CLI 会开新标签，避免 Nomi 历史被 CLI 污染；跨端分叉是上下文粘贴，不是会话续接。
- **示意**：见 [`assets/chat-mode/`](./assets/chat-mode/)（storyboard SVG；headed e2e 截图可替换）。

## 13. 验收反馈整改（2026-10-15，PR #8）

### 13.1 提供商隔离调查（反馈 3）— 结论

**用户看到的现象**：在 Claude Code / Codex 标签的输入栏里出现 Nomi 的供应商 / 模型，担心 Nomi 的设置串到了 CLI 里。

**查证结果（用大白话）**

1. **显示是错的，配置没有串。** 输入栏里的「供应商 / 模型」选择器原来是 Nomi 自己的，不管当前是哪个端点都显示它，所以看起来像是 CLI 在用 Nomi 的模型。实际上 CLI 标签发消息时只读它自己的配置，不读 Nomi 的选择。已改为：CLI 标签显示**该 CLI 自己的**供应商 / 模型（只列该端点自己档案库里的档案）；没有启用任何档案时明确显示「CLI 默认 / 已登录」；🔑 按钮直达该端点的供应商设置页。
2. **启动 CLI 子进程时会把 Nomi 的环境变量带进去。** 原来直接继承 Nomi 进程的环境变量（`NOMI_*`、`IG_*`、`CD_*`、MCP 相关变量）。这些不是 CLI 的配置，但属于不该泄露的内部状态。已改为子进程环境统一经过 `buildCliEnv`：剥掉这些内部变量，其余（`PATH`、`HOME`、用户自己设置的 `ANTHROPIC_*` / `OPENAI_*` 等）原样保留；dsh 的 Key 只通过显式的 `NOMI_DSH_API_KEY` 注入。
3. **没有档案时不会写任何 CLI 配置文件。** Codex 档案库为空时，既不写 `~/.codex/config.toml` 也不写 `auth.json`；启用 Claude 档案不会碰 Codex 的文件，反之亦然。（有隔离测试 `CliIsolation.test.ts`。）
4. **补上了「停用」。** 以前启用过的档案没办法退回 CLI 自带登录。现在每个端点都能「改用 CLI 自带登录/默认配置」：Claude 只移除我们写入的 `ANTHROPIC_API_KEY / BASE_URL / MODEL`；Codex 移除 `[model_providers.nomi]`、对应的 `model` / `model_provider` 和我们写入的 `OPENAI_API_KEY`；dsh 只移除带标记的区块；都先备份。
5. **已知限制**：Nomi 自己（主标签）的任务路由 / 供应商仍是 Nomi 自己的一套，与 CLI 无关；用户在自己的 shell 里导出的 `ANTHROPIC_*` / `OPENAI_*` 会被 CLI 继承，这是用户自己的环境，不做剥离。

### 13.2 端点命名、图标、工作目录（反馈 1 / 4 / 5）

- 端点统一名称 **Nomi / Claude Code / Codex / dsh**（专有名词，不翻译；不再出现 `CC`、`CX`、「Codex CLI」之类缩写）。下拉、侧栏、标签、分叉菜单、看板娘监视器使用同一份 `ENDPOINT_NAME`。
- 端点下拉：选项只有名称，菜单宽度按内容撑开（最小 200px），不再被截断；CLI 未安装时整项置灰并标「未安装」。
- 端点图标（`EndpointIcon`，自绘 SVG，不依赖外部品牌素材）取代文字徽标：侧栏条目、「按端」筛选、标签、新建菜单、分叉菜单、看板娘监视器与灵动岛都用同一套图标和配色。图标带 `aria-label`，不靠颜色单独表意。
- **工作目录**：所有 CLI 端点（不止 Codex）在输入栏有统一的目录选择器；新建对话 / 标签 / 分叉时也能先选目录。含「最近使用」（最多 8 个，已不存在的自动过滤）与「选择其它文件夹…」。已有会话的标签切换目录时会确认并丢弃旧会话（CLI 会话与目录绑定）。悬停显示完整路径，界面只显示缩短后的路径。

### 13.3 菜单审计与重整方案（反馈 6）

**整改前的问题**：同一类动作有多个入口且样式不同——

| 动作                 | 整改前                                                                 | 整改后                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新建对话 / 标签      | 侧栏「新对话」菜单、标签栏「+」菜单、BackendSwitcher「目录」按钮各一套 | 唯一的 `NewChatMenu` 组件（端点 + 图标 + 目录），侧栏与标签栏共用；快捷键 Mod+N（Nomi）/ Mod+T（CLI 标签）                                               |
| 对话右键             | 侧栏：分叉 / 跨端分叉 / 删除；标签：只有 × 和双击改名                  | 唯一的 `ConversationMenu`：重命名 / 分叉为新对话 / 分叉到其他端 /（CLI）关闭标签 /（Nomi）删除对话；侧栏条目与顶部标签都能右键打开；方向键移动、Esc 关闭 |
| 端点 / 目录 / 供应商 | 输入栏里三处分散控件 + 额外一条 cwd 条                                 | 一组 `EndpointControls`：端点 → 目录（CLI）→ 供应商 / 模型                                                                                               |
| 供应商配置           | 「AI 供应商」设置页 + 编程助手面板（日程里内嵌）两处                   | 一个「编程助手」页（§13.4、§14）                                                                                                                         |

约定：

- **关闭 vs 删除**：关闭 = 只关掉标签，CLI 会话仍在磁盘，可从历史重新打开；删除 = 永久移除 Nomi 对话。CLI 条目不提供「删除」，Nomi 条目不提供「关闭」，避免两个含义不清的按钮。
- 「普通 / 开发」模式开关保持在顶栏左上角，位置与行为不变。
- 顶栏右侧的功能入口（知识 · 记忆 · 日程 / 扩展 / 本机 / 设置）与「固定到左上角」右键菜单不变。
- 菜单可键盘操作：打开后焦点落在第一项，↑/↓ 移动，Enter 确认，Esc 关闭。

**快捷键清单**（Mod = macOS ⌘ / 其它 Ctrl；可在设置 → 快捷键改绑，设置页同样展示固定键位）：

| 操作                             | 默认                      |
| -------------------------------- | ------------------------- |
| 命令面板                         | Mod+K                     |
| 新对话（Nomi）                   | Mod+N                     |
| 新建编程助手标签（弹出端点菜单） | Mod+T                     |
| 关闭当前标签 / 重命名当前标签    | Mod+Shift+W / Mod+Shift+R |
| 下一个 / 上一个标签              | Ctrl+Tab / Ctrl+Shift+Tab |
| 跳到第 n 个标签                  | Mod+1 … Mod+9             |
| 把当前对话分叉为新对话           | Mod+Shift+F（固定）       |
| 收起 / 展开侧栏                  | Mod+B                     |
| 打开设置                         | Mod+,                     |
| 菜单内 移动 / 确认 / 关闭        | ↑↓ / Enter / Esc          |

### 13.4 「供应商」页：按端点分别配置

设置 →「编程助手」只有一个页面。顶部标签：Nomi / Claude Code / Codex / dsh / 监视与会话（选择会记住），每个端点是**完全独立**的一块，切换只是换视图，不改动任何配置。三个 CLI 端点与 Nomi 用**同一套**第三方供应商交互（见 §14.1）：

- **说明**：配置写到哪里、与其它端点互相独立。Claude Code 只改 `~/.claude/settings.json` 的 env；Codex 只改 `~/.codex/config.toml` 与同目录 `auth.json` 的 `OPENAI_API_KEY`；dsh 只写 `$DSH_HOME/cordis.patch.yml` 里带标记的区块（密钥不落盘，启动时用环境变量注入）；Nomi 用自己的 `ai-providers.json`。以上都先备份、保留无关内容。
- **当前使用**：供应商名称、**来源**（Nomi 档案库 / CLI 自带登录或默认配置）、上游格式、模型、**本地路由状态与原因**（直连：原生格式；已开启：非原生格式经本机路由转换；需要但未开启：提示去「高级」打开；dsh：无需路由）。
- **档案**：启用 / 测速 / 编辑 / 删除。测速（主进程 `ai:cli-provider:test`）对上游发一次 `GET /models`（OpenAI 兼容 Bearer；Anthropic 用 `x-api-key`；Gemini 用 `x-goog-api-key`），8 秒超时，返回耗时；401/403 提示 Key 无效；没有模型列表接口（404/405）视为已连通；错误信息里的 Key 会被抹掉。
- **「高级」**：本地路由开关（Claude Code / Codex）、档案库与写入文件路径。dsh 的高级里只有说明（原生支持三种协议，无需路由）。
- **任务路由**（对话 / 工具调用 / 摘要）只在 **Nomi** 区，沿用原有 `ProviderPanel`；CLI 端点没有任务路由。
- 存储与 IPC 语义不变：`ai:cli-provider:*`（`upsert` / `remove` / `activate` / `deactivate` / `state` / 新增 `test`）、`ai:cli-route:*`。
- 入口：设置 → 编程助手；输入栏供应商芯片的「管理」直接跳到对应端点。「日程与日历」没有编程助手标签（§14.3）。

### 13.5 历史会话（Claude Code / Codex / dsh）

**范围**：开发模式下，侧栏除了 Nomi 的对话与已打开的 CLI 标签，还列出本机磁盘上各 CLI **已有的**历史会话（包括在终端里直接用 CLI 产生的），点一下就在新标签里续接。普通模式不扫描、不显示。

**数据源与解析**（主进程 `SessionHistoryService`，只读本机文件，不联网）：

| 端点        | 位置                                                                                                                                      | 元信息                                                                                                                           | 续接命令                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/<编码后的 cwd>/<sessionId>.jsonl`                                                                                     | 首个真实提问做标题、`cwd`、`sessionId`；子代理（`isSidechain` / `subagents/`）不单列；只有 `queue-operation`、没有提问的文件跳过 | `claude -p … --resume <sessionId>`                            |
| Codex       | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`                                                                                            | `session_meta` 取 `id` / `cwd`（头部含超大 `base_instructions`，读 512KB 头部）；环境上下文、`AGENTS.md` 等注入内容不当标题      | `codex exec resume <id> …`（cwd 由进程目录决定）              |
| dsh         | `$DSH_HOME/sessions/<编码后的 cwd>/session-<uuid>/session.v4.jsonl.zstd`，标题 / cwd 来自 `storages/session_projcache/sessions/<id>.json` | 明文索引，列表不解压                                                                                                             | `dsh --profile headless --json --session-id session-<uuid> …` |

- **增量扫描**：目录列表 3 秒内复用；每个文件的解析结果按 `(mtime, size)` 缓存，只重读变化的文件（测试里断言未变化时不再打开文件）。全程异步 I/O，不阻塞主进程。
- **分页**：按修改时间倒序，**每个端点 50 条**，「加载更多」取下一页（`offset` 是候选文件序号，被过滤的文件不占名额）。「全部」视图合并三个端点按时间排序，「加载更多」同时翻各端点的下一页；「按端」视图只看当前端点。窗口重新获得焦点、标签集合变化、点「↻」时刷新。
- **去重**：已经绑定在某个标签上的会话（`backend + cliSessionId` 相同，含主标签）不会再出现在历史里；同一会话再次打开会直接切到那个标签，不会新建重复标签。
- **打开**：`ai:history:open` → 检查原工作目录仍存在（续接要求同目录，否则提示「原工作目录已不存在」，条目也会置灰）→ 读出**可见转录**（用户 / 助手文本，工具只记名字，最近 300 条）→ 新建标签并绑定 `cliSessionId` 与原 cwd，转录预填；之后发送的第一条消息就用上表的续接命令。
- **转录是尽力而为**：Claude 合并同一次回复的多个片段，跳过 `tool_result`、`isMeta`、子代理；Codex 只取 `response_item` 里的 `user` / `assistant` 消息并跳过环境 / 指令注入，函数调用记为工具名；dsh 只取 `source.kind = user` 的提问与 `assistant/message`（`.zstd` 用 Node 内置 `zlib.zstdDecompressSync`，不可用时回退系统 `zstd`）。解析不出来时标签是空的，并提示「没有解析到可显示的历史消息，仍可继续该会话」——续接本身不依赖转录。文件超过 12MB 时只读尾部并提示。
- **测试**：夹具来自真实会话文件（`packages/electron/tests/fixtures/history/`，已裁掉超长指令）；覆盖三种解析器、分页（120 条 → 50/50/20）、增量、去重、cwd 缺失、转录失败、以及 mock CLI 的续接参数（`--resume` / `exec resume` / `--session-id`）。
- **已知限制**：只支持这三个端点；没有对话内容搜索；dsh 的转录格式是内部格式（v4），升级后可能需要跟进解析器；Claude Code 的会话如果在终端里仍在运行，续接会和它同时写同一个文件。

## 14. 验收反馈（2026-10-15，macOS 开发模式）

### 14.1 编程助手页：三个 CLI 端点与 Nomi 同款第三方供应商交互

- 设置里「编程助手」是一个页面，标签：`Nomi` · `Claude Code` · `Codex` · `dsh` · `监视与会话`（`CodingTab`，记在 `chatPrefs`）。
- Claude Code / Codex / dsh 与 Nomi 使用同样的视觉与流程：**卡片列表**（图标 · 名称 · 「使用中」徽标 · 上游格式 · 地址 · 模型 · 打码 Key）→ **添加供应商**打开预设模板网格（含「自定义」）→ 表单（名称、接口地址、API Key、模型、上游格式）→ 保存；每张卡片有 测速 / 编辑 / 删除（删除前确认）/ 启用。预设模板复用 Nomi 的预设（只预填名称 / 地址 / 模型 / Key）；新建上游格式一律取该 CLI 端点原生默认（Claude=`anthropic_messages`，Codex / dsh=`openai_responses`），不被预设 protocol 改写；用户可再改格式，非原生时提示需本地路由。
- **默认是「CLI 自带登录 / 默认配置」**：列表第一张固定卡片，没有任何档案启用时它就是「当前」；启用某个档案后可随时「改用 CLI 自带登录/默认配置」。
- **隔离不变**：四套档案库互相独立；本地路由仍在 Claude Code / Codex 各自的「高级」里；dsh 无需路由。
- 档案新增 `presetId`（可选，旧档案没有时按地址推测品牌图标），仅用于显示品牌图标。

### 14.2 版本检测、安装与更新（Claude Code / Codex / dsh）

每个 CLI 端点页顶部有 **「版本」卡片**：状态（未安装 / 已安装 / 有新版本 / 已最新 / 运行时过旧）、已装版本、最新版本、位置，按钮「检查更新」与「安装 / 更新 / 重新安装」。

- **流程**：计划（只读，`ai:cli-update:plan`）→ **确认对话框**（展示将执行的**完整命令**、需求检查、是否需要联网）→ 执行（`ai:cli-update:run`）→ 实时输出通过 `ai:cli-update:event` 推到日志区 → 结束后自动重新检测。出错时显示原因与日志，不静默。
- **命令白名单**（只用 argv，不拼 shell 字符串；仅 Windows 的 `.cmd` 例外）：`npm install -g <包>@latest`、`claude update`、`codex update`；包名固定为 `@anthropic-ai/claude-code`（Node ≥ 22）、`@openai/codex`、`@deepseek-ai/dsh`（**Node ≥ 24**）。
- **需求检查**：Node 版本不够、没有 npm、全局目录不可写，都会在确认框里以本地化原因拦住，不执行。
- **不静默 sudo**：全局目录只读（如系统 Node）时，给出「安装到 `~/.local`（`--prefix`）」的备选方案并要求确认，绝不自动提权。
- **dsh 现在可以安装与更新**（取代 §10 第 5 条与 §12.3 中「不负责安装」的旧决定）。
- **不阻塞主进程**：检测（`which` / `--version` / `npm config get prefix` / `node --version`）全部走异步 `execFile`；`run` 在做前置检查前先占位，防止连点两次同时通过。（Windows 上 `where` / `npm.cmd` 启动较慢，同步调用会让整个应用的输入停顿——CI 里 E19 的点击曾因此超时。）
- **任务状态由主进程按端点持有**（`CliUpdateService.jobs`）：运行中 / 进度日志（最多 400 行）/ 结果 / 错误都在主进程，不再放在设置页的 React 局部状态里。页面挂载时先 `ai:cli-update:job` 取快照，再订阅 `ai:cli-update:event` 的增量；切换端点、退出设置、关闭再打开都不影响任务，回来后继续显示。同一端点重复点更新会复用当前任务；结束后保留最近一次结果（含失败原因），直到点「关闭结果」（`ai:cli-update:dismiss`）。测试：`CliInstallUpdate.test.ts`（快照 / 复用 / 保留 / 关闭）、`cliVersionCard.test.tsx`（挂载→开始→卸载→重新挂载仍显示）、e2e E20（假 codex / npm）。
- 已移除日程里的 `CliToolsBlock`。
- 测试：`packages/electron/tests/unit/cli/CliInstallUpdate.test.ts`（注入 mock npm / CLI 的 probe 与 runner，覆盖计划、Node 过旧、只读前缀、流式事件、失败）与 `packages/ai-chat/tests/cliVersionCard.test.tsx`。

### 14.3 监视与会话

- 「日程与日历」只含提醒、定时与日历，没有「编程助手」标签。
- 原标签里的内容拆开：**版本**→ 各端点页（§14.2）；**监视开关、系统通知开关、已检测工具、立即扫描、会话列表（按端点筛选、打开标签）**→ 编程助手 →「监视与会话」；**通知 / 灵动岛的来源与样式设置**仍在「通知 / 灵动岛」，「监视与会话」里有一个按钮直达。
- 日程在顶栏「知识 · 记忆 · 日程」抽屉的「日程」标签，也在设置 → 日程与日历（快捷键 `Mod+Shift+M` 打开抽屉）。

### 14.4 菜单栏图标消失（macOS，开发模式）

**现象**：在开发模式里和模型互动（编程助手任务完成等）之后，菜单栏里的托盘图标与应用菜单消失，Dock 图标也可能消失。

**根因**：灵动岛窗口在 macOS 上调用了 `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`。Electron 的这个调用默认会**切换进程类型**（普通应用 ↔ 菜单栏代理应用）：为了让窗口出现在全屏空间上，应用会短暂变成「没有 Dock / 菜单栏」的代理应用，再变回去，这一来一回就把状态栏图标和应用菜单弄丢了。而灵动岛窗口会在每次有编程助手事件（完成 / 失败）或几何变化时被创建、显示，所以「互动之后」才出现。

**修复**（`IslandService.applyIslandWorkspaceBehavior`）：传 `skipTransformProcessType: true`，不再切换进程类型。同时加固托盘（`TrayManager`）：模块级强引用防回收、图标永远非空（缺图时用兜底图）、`activate` / `browser-window-focus` 时检查托盘是否还在，不在就重建（`ensureAlive`），`dispose` 幂等。
**回归测试**：`packages/electron/tests/unit/core/trayLifecycle.test.ts`（断言灵动岛始终带 `skipTransformProcessType`、托盘被销毁后能重建、空图标不会被设置）。
**已知限制**：根因来自代码与 Electron 行为分析，没有在真实 macOS 上复现过；需要在 macOS 开发模式上验收。

### 14.5 端点图标

Nomi 用 Nomi 应用标志；Codex 用 OpenAI 标志；dsh 用 DeepSeek 鲸鱼；Claude Code 保持原样。字形取自 lobe-icons（MIT，`@lobehub/icons-static-svg` 1.95.1，已随 `packages/ui/src/brand/icons.ts` 内置），数据在 `packages/ui/src/brand/endpointGlyphs.ts`，聊天窗口与灵动岛页面共用；署名见根目录 `THIRD_PARTY_NOTICES.md`。品牌标志归各自所有者所有，仅用于标识对应工具。

### 14.6 侧栏顶部改版、会话搜索、普通模式只显示 Nomi

**顶部**：第一行 `[折叠] [Nomi 标志 + Nomi] …… [搜索图标] [新建图标]`。标志用应用自己的图标（`docs/brand/nomi-app-icon.svg` 的同一份字形，与端点图标共用 `endpointGlyphs.ts`）。原来整行的「新对话」按钮改成图标按钮（tooltip「新对话 ⌘/Ctrl+N」）：普通模式点击直接新建 Nomi 对话；开发模式「全部」视图弹出端点菜单（菜单右对齐在图标下），「按端」视图直接为当前端点新建。「全部 / 按端」分段控件缩成 20px 高，与「对话」分组标题同一行（右侧），不再独占一行；「按端」下的端点筛选条只在开发模式的按端视图出现。折叠态只剩折叠与新建两个图标。无布局跳动：搜索框在原位替换品牌与图标，行高不变。macOS 红绿灯在应用标题栏里，侧栏不受影响。

**搜索**（`⌘/Ctrl+F` 或点搜索图标；可在设置 → 快捷键里改绑，id `searchChats`）：

- 在原位展开为搜索框（`role=search`，输入框 `role=searchbox`）；`Esc` 先清空、再收起；`↑ / ↓` 选择、`Enter` 打开；结果区是 `role=listbox`，每行 `role=option`，用 `aria-activedescendant` 指向当前项。
- 防抖 150ms；纯函数模糊匹配 `utils/fuzzy.ts`：查询按空白切词，**每个词都要命中**；子串优先（开头 / 词边界加分），其次子序列容错（`rflg` → `Refactor login flow`，跨度过大的噪声不算），单字符只做子串；全角半角、大小写不敏感；中文按字匹配。字段权重：标题 3 > 首条用户消息 2 > 工作区路径 1.5 > 端点名 1。标题上的命中片段高亮（`<mark>`）。
- 范围：「全部」搜 Nomi 会话 + CLI 标签会话 + Claude / Codex / dsh 磁盘历史；「按端」只搜当前端点。结果按 `backend:sessionId` 去重（已加载分页与索引合并时只留一条）。
- **磁盘历史**由主进程提供紧凑索引 `ai:history:index`（与 `list` 同一套增量解析和去重：只重读变化的文件；一块最多 1000 条、默认 500，不逐条检查目录是否存在）。界面在搜索激活后才拉取，自动取到每端 2000 条，之后「搜索更早的历史」按钮再取下一块；匹配在内存里做，渲染最多 200 条并提示「请输入更多关键词」，不会在每次渲染时全量扫描。
- 搜索不影响会话点击路由、右键菜单（重命名 / 分叉 / 关闭 / 删除）与分叉；无结果显示空状态。

**普通模式只显示 Nomi**：侧栏只列 Nomi 会话；隐藏「全部 / 按端」、端点筛选、「编程助手历史会话」、CLI 标签会话；搜索只搜 Nomi，也不拉磁盘历史；新建对话直接是 Nomi。保存的视图选择（全部 / 按端、端点）不会被改掉，切回开发模式即恢复。若当前选中的是 CLI 会话，切到普通模式时自动切到最近的 Nomi 会话（没有则新建空 Nomi 对话），并记住原会话，切回开发模式时回到它；CLI 标签继续在后台运行。

测试：`fuzzy.test.ts`（排序 / 中文 / 容错 / 限量）、`sidebarSearch.test.tsx`（顶部、过滤、高亮、键盘、去重、空状态与「搜索更早的历史」、200 条上限、普通模式、模式切换恢复）、`SessionHistory.test.ts`（索引分块）、e2e E19（顶部、搜索、普通模式）。

### 14.7 灵动岛版式整改：顶部空白过多（2026-10-15）

**现象**：岛上方（内容上面）是一大块纯黑，内容被挤在下半部分；贴在菜单栏下时，岛上沿比菜单栏更宽、顶部多出一截黑。

**根因**（`island/geometry.ts`、`islandPage.ts` 旧实现）：

1. 刘海屏窗口高度 = 菜单栏高度 + **固定 76px**，内容行固定 76px 并贴底，而图标只有 38px —— 内容上下各剩约 19px，再加上顶部整块刘海高度（约 37px），上面一共约 56px 空黑；
2. 胶囊（无刘海）也用固定 76px 高，内容 38px，同样上下各 19px 空黑；
3. 窗口高度与内容高度没有关系（长短正文都一样高），也没有按内容量。

**整改**：窗口高度 = 内容高度（页面 `prepare()` 量出内容行高度，主进程 `setBounds` 后再显示并展开）；胶囊上下各 11px 对称；刘海屏只预留真实刘海高度，并把图标 / 状态点放进刘海带两侧，文字紧贴其下（4px / 12px）。刘海版 91px（改前 113px），胶囊 60px（改前 76px）；无正文时更矮。详见 [灵动岛](dynamic-island.md)。

**一并修的另一个问题**：岛窗口原来用默认会话，统一 CSP 响应头会拦掉它的内联脚本，非开发模式下岛不会展开。现在岛用独立内存会话（`partition: 'nomi-island'`）。

**测试**：`island.test.ts`（高度计算、夹取、刘海 / 胶囊预留、窗口矩形、页面样式类）、`trayLifecycle.test.ts`（仍断言 `skipTransformProcessType`）、e2e `E21`（真实窗口：高度、上下内边距对称、与顶部间距、刘海带布局）。**只能在 Mac 上确认**：真实刘海与菜单栏高度、与物理刘海的衔接、毛玻璃 / 投影观感、专注模式、全屏与多显示器行为。

### 14.8 会话行尾操作（重命名 / 删除 / 更多）

侧栏每一行在鼠标悬浮、行内键盘焦点（`focus-within`）、选中行、触屏设备（`hover: none`）时，在行尾显示三个图标按钮（带 tooltip 与 `aria-label`）：

- **重命名（笔）**：行内编辑，Enter 确认、Esc 取消（沿用原有重命名输入框）。
- **删除（垃圾桶）**：Nomi 对话先二次确认（行内变成「确认删除 / 取消」，Esc 或 5 秒后自动取消）；CLI 标签行的垃圾桶是「关闭标签」（会话仍在磁盘，可从历史重新打开），标签正在运行时沿用「该标签仍在运行，关闭会中止它」确认——右键菜单里的「关闭标签」同样会确认。
- **更多（···）**：打开与右键菜单**同一个** `ConversationMenu`（分叉为新对话 / 分叉到其他端 / 关闭标签 / 删除对话…），锚在按钮下方；菜单只在点击时渲染，行内不常驻挂载。
- **磁盘历史会话（只读）**：没有重命名 / 删除，「更多」（也可右键）里只有「在标签中打开」。
- 普通模式同样可用（只有 Nomi 对话）。

排版：图标浮在行尾，时间文字隐藏（占位不变），标题尾部用渐隐遮罩让位，列表没有布局跳动。按钮是行按钮的兄弟节点，不嵌套 `<button>`。搜索结果行仍只有右键菜单。

测试：`sidebarRowActions.test.tsx`（9 个：图标 / tooltip / aria、行内重命名、二次确认与取消、标签关闭与运行中确认、「更多」菜单与右键同源、历史只读、普通模式）、e2e E19（悬浮 / 焦点显示、历史行只读、改名取消、删除确认）。

### 14.9 普通模式不能跨端分叉

「分叉到其他端」（把 Nomi 对话复制到 Claude Code / Codex / dsh 标签）属于开发模式的能力。**普通模式**下：会话右键菜单与行尾「···」菜单只有「分叉为新对话」（同端 Nomi 副本，`⌘/Ctrl+Shift+F` 同样可用），没有「分叉到其他端」；`App` 里的 `onForkRequest` 也会忽略普通模式下的跨端请求，已打开的目标选择框在切到普通模式时自动关闭。开发模式行为不变。（之前菜单项没有按模式过滤，普通模式也能分叉到其他端，属于漏网。）菜单仍是同一份 `ConversationMenu`，只是不传 `onForkCross`。测试：`sidebarRowActions.test.tsx`（开发模式有 / 普通模式无）、e2e E19。

### 14.10 提示策略：开始不打扰、定时汇总、总结播报

设置 → 编程助手 →「监视与会话」。

**1. 只在结束 / 需要你时提示。** 编程工具（Claude Code / Codex / dsh 及其它被监视的工具）任务**开始 / 进行中**时，看板娘不弹气泡、不出声、不放音效，灵动岛也不弹；运行中的状态只在「监视与会话」列表里被动展示。以下提示保持不变：任务完成 / 失败、这一轮做完在等你回复、疑似卡住、**工具权限请求**（需要你操作，仍然弹出）。

**2. 每 10 分钟汇总一次。** 打开「监视编程助手进度」后，主进程每 10 分钟（常量 `DIGEST_INTERVAL_MS`）重新扫描一次；若有进行中的编程任务，发一条汇总：「还有 N 个编程任务进行中（Claude Code 2 · Codex 1）」，通过气泡与灵动岛被动告知。规则：

- 0 个任务不提示；Nomi 原生对话不计入；已在设置里关闭的工具不计入。
- 刚发过结束 / 权限 / 卡住提示后的 1 分钟内（`DIGEST_QUIET_AFTER_REMIND_MS`）跳过本轮，避免与结束提示叠加刷屏；免打扰时段内也不弹。
- 汇总默认**不出声**（只有气泡 + 灵动岛）。
- 关闭监听（或退出应用）会清理汇总定时器；重新打开后重新计时（第一次汇总在 10 分钟后）。

**3. 总结播报（默认关）。** 设置里新增开关「总结播报」，持久化在监视设置（`summaryEnabled`）：

|          | 关（默认）                                                  | 开                                                 |
| -------- | ----------------------------------------------------------- | -------------------------------------------------- |
| 定时汇总 | 仅气泡 / 灵动岛，不出声                                     | 在数量之外附带最多 2 个任务的最近进度，并朗读      |
| 任务结束 | 气泡 / 灵动岛的简短提示，只播一句固定台词和音效，不朗读结果 | 朗读完成总结：做了什么（任务标题）、成败、结果摘要 |

- 进度摘要不新增任何模型调用：Nomi 标签取该轮最近的文本 / 工具步骤（`CliHarnessService.progressHint`，仅内存），文件会话取已有的「最后一步」摘要（`SessionInfo.detail`）。
- 朗读走现有的看板娘语音通道（`MascotCueService` → `speakForActiveCharacter` → `tts:speak`），遵守语音开关、音量与勿扰静音；e2e 下 `CD_TTS=off` 照常生效。
- 实现：主进程 `desktop:bubble` 载荷新增 `voice`（`full` / `cue` / `none`）与 `kind`（`digest` / `done` / `fail`），渲染进程 `MascotAudioBridge` 据此决定出声方式；未带 `voice` 的旧气泡沿用原有行为。

**测试**：`packages/electron/tests/unit/agents/agentDigest.test.ts`（fake timers：开始不提示、10 分钟汇总与分组、0 个不提示、总结播报开 / 关、与结束提示去重、免打扰、关闭监听 / `stop` 清理定时器）、`agentProgress.test.ts` / `agentEndpoints.test.ts`、`HarnessTabs.test.ts`（`progressHint`）、`packages/renderer/tests/mascot/audioBridgeBubble.test.tsx`（三种出声方式）、`packages/ai-chat/tests/providersPage.test.tsx`（开关）。**未验证**：真实语音听感，以及 Windows / macOS 真机上的气泡、灵动岛与定时行为。

## 14. 会话视图改版（2026-10-16，工具调用不再是纯文本流）

验收反馈：开发模式下工具调用是一长串绿色「工具完成：xxx」纯文本。改为参考 Codex Desktop 的交互思路（自行实现）：

- **数据**：主进程解析各后端的工具参数 / 输出 / 思考 / 子代理父子关系（`streamParse.ts`），给事件打时间戳，
  每轮结束把有界的 `trace` 写进助手消息（`traceBuilder.ts`，≤300 条、≤400 KB，超限先丢最早的输出）。
  旧消息只有 `tools: string[]`，渲染端回退成已结束的调用。
- **渲染**（现为统一视图 `ai-chat/src/components/Conversation`，见第 15 节）：用户气泡右对齐；助手正文走自带的轻量 Markdown（AST → React，无 innerHTML，
  链接只放行 http/https/mailto）；工具调用为紧凑行（lucide 图标 + 动作摘要 + 状态 + 耗时）。
- **分组**（`utils/toolTrace.ts`）：连续的「探索」（读 / 搜 / 列 / 联网）、「命令」、「编辑」、「其它」各 ≥2 个折叠成一组
  （「已探索 3 个文件、5 次搜索」），默认折叠；单个调用保持单行；单个编辑默认展开 diff；子代理（Task / spawn_subagent）独立成块，
  内部调用按 `parentId` 嵌套；思考可折叠。
- **滚动**：贴底才自动跟随，上滑不抢滚动条并出现「回到底部」；自己发消息或切标签回到底部。
- **Mock**：`NOMI_MOCK_TOOLS=rich`（Claude）/ `NOMI_MOCK_SCENARIO=rich`（Grok）+ `NOMI_MOCK_STEP_MS` 产生多种工具调用，见 E24。

## 15. 统一会话视图 + 完整交互 + 性能治理（2026-10-16）

**统一**：Nomi 普通对话（含 `main` 标签）与 Claude Code / Codex / Grok / dsh 标签共用同一个 `ConversationView`，不再各写一套。

```
ai-chat/src/
  types/conversation.ts        ConvMessage / ConvLive / ConvPhase（与来源无关的会话模型）
  utils/convAdapters.ts        HarnessTabMessage / ChatMessage → ConvMessage（按源对象缓存，保持引用稳定）
  utils/convStatus.ts          等待态推导（排队 / 权限 / 压缩 / 重试 / 重连 / 子代理 / 工具 / 思考 / 等待首字 / 生成）
  utils/convTime.ts            按分钟合并的时间标签、完整时间、耗时 / token / 费用摘要
  utils/toolTrace.ts           trace → 时间线（分组 / 子代理 / 思考起止）
  components/Conversation/
    index.tsx                  ConversationView：分页、贴底跟随、实时一轮、排队气泡
    Messages.tsx               用户气泡（编辑重发）、助手消息（时间线 + 正文 + 元信息 + 操作）、错误卡片
    StatusLine.tsx             等待态状态行（图标 + 文案 + 已用时 + 停止）
    ToolTimeline.tsx / Markdown.tsx / DiffView.tsx
    nomiSlots.tsx              Nomi 独有内容（参考记忆 / 图片 / 知识库引用 / 来源）通过 slots 注入
```

- **Nomi 的工具调用 / 思考同走 trace 模型**：`ChatChunk` 新增 `tool_call.result`、`reasoning`；`AiSdkLlmProvider.runStream` 把
  ai-sdk `fullStream` 的 `tool-call` / `tool-result` / `tool-error` / `reasoning-delta` 映射过来；渲染端 `chunkToTrace` 转成
  `HarnessTraceEvent` 并随消息保存（`ChatMessage.trace / durationMs / usage`）。
- **历史会话**：`historyTranscript.ts` 解析 Claude / Codex / dsh 记录里的工具参数、输出、思考、`usage`，并由用户消息到结果的时间差得出
  每轮耗时（Codex 的 `reasoning` / `function_call` / `local_shell_call` / `custom_tool_call` 及其输出配对）。
- **等待态**：排队、等待权限、等待首字、重试 / 重连（`api_retry`、Codex `reconnecting`，带 n/m）、上下文压缩、子代理运行、工具运行、
  思考、生成回复、被中断，各有独立图标与文案；状态行带本轮已用时与「停止」。
- **思考块**：流式时默认展开并计时（「思考中 · 12s」），结束后自动折叠为「已思考 N 秒」；用户手动切换后尊重用户选择。
- **时间与摘要**：同一分钟内的相邻消息只显示一次时间，悬停显示完整时间（精确到秒）；每轮结尾显示「用时 · 输入 / 输出 token · 费用」（有数据才显示）。
- **消息操作**：复制；最后一条助手消息「重新生成」（Nomi 从对应用户消息截断重发；CLI 标签以同一提示词发起新一轮——CLI 会话无法回滚）；
  用户消息「编辑并重新发送」（同上）；运行中「停止」，中断后保留已生成内容并标记「已停止生成」。
- **错误卡片**：失败原因 + 重试 / 复制。Claude 的 `result.is_error` 现在按错误处理（此前被当成正常回答）。
- **队列**：运行中输入框保持可用，Enter 排队（发送键变「排队」，输入为空时是「停止」）；队列显示为虚线气泡，可移出；本轮结束后自动按序发送。
  CLI 标签的队列在 `HarnessTabsContext` 按标签维护，Nomi 主对话用 `useSendQueue`。
- **长对话**：只渲染末尾窗口（30 条或体量预算），「显示更早的 N 条消息」增量加载并保持视口不跳；时间线顶层 60 步窗口。

**性能根因与修复**（压测：`e2e-headed/tests/PERF.cli-stress.headed.spec.ts`，`NOMI_PERF=1`，Mock Claude `NOMI_MOCK_TOOLS=stress`，12 轮 × 1000 个工具调用 + 200 KB 流式 Markdown，之后 50 次切标签）：

| 指标                                    | 9da964b               | 现在                    |
| --------------------------------------- | --------------------- | ----------------------- |
| 长任务（>50ms）次数 / 总耗时            | 97 / 16.1 s           | 11 / 1.6 s              |
| DOM 节点（跑完后）                      | 50 248                | 5 220                   |
| 切标签渲染 p50 / max                    | 411 / 666 ms          | 94 / 156 ms             |
| 重开历史渲染                            | 540 ms                | 88 ms                   |
| 渲染进程内存峰值 / 跑完后 / 50 次切换后 | 131.6 / 21.9 / 8.3 MB | 81.4 / 10.5 / 8.7 MB    |
| 监听器（基线 → 50 次切换后）            | 423 → 431             | 423 → 431（无逐次增长） |

根因：① 每个流式 delta 都 `setState` 并复制整个轨迹数组 → 主进程 `EventBatcher` 合并 + 渲染端 `requestAnimationFrame` 合批（`applyLiveEvents`，实时轨迹封顶 3000）；
② 每次渲染都重算 `reduceTrace` / `buildTimeline` / Markdown / diff → 行 / 组 `memo`、增量 Markdown 分块（`splitMarkdownChunks`）、diff LRU 缓存；
③ CLI 会话整段渲染、不分页 → 消息 / 时间线窗口化；④ 持久化的旧轨迹保留完整输入输出 → `compactOldTraces`（仅保留最近 20 条完整，文件 ≤6 MB）；
⑤ 切标签缓存无限增长 → LRU 只留最近 4 个标签。看板娘窗口堆内存稳定在 10–12 MB，没有随会话增长。

**测试**：`ai-chat/tests/conversation*.test.tsx`、`convStatus` / `convTime` / `toolTrace` / `sendQueue` / `stopButton`、`electron/tests/unit/cli/*`；
e2e：E24（工具时间线）、E25（统一视图：等待态 / 思考计时 / 队列 / 摘要 / 停止 / 重新生成 / 编辑 / 错误卡片 / Nomi 对话）、PERF（压测，默认跳过）。
