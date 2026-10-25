# Nomi 把编程助手当子代理调用（设计稿）

> 状态：P1 + P2（异步默认）+ P3（git worktree 隔离）已实现（v2.0.0）；起草 2026-10-24。实现偏差见 §12。
> 相关：[编程助手权限模式](cli-permission-modes.md)（§4.1 Nomi 自己的工具）、[编程助手子代理](cli-subagents.md)、
> [编程助手插件化](cli-plugin-architecture.md)、[模型质量](model-quality.md)。

## 1. 背景与目标

Nomi 对话现在只能调用自己的工具（文件、剪贴板、浏览器、知识库、记忆、MCP）。编程助手（Claude Code / Codex /
Grok / Gemini / dsh / 外部 CLI）只能由用户在标签里直接使用。

目标：Nomi 在对话里可以把一件具体的事**交给某个编程助手去做**，等它做完拿回结果，再继续和用户对话。
例如「让 Codex 修一下这个仓库的登录 bug，修完告诉我改了什么」。

不做的事：

- 不让编程助手反过来调用 Nomi 再派任务（见 §6.4，只允许一层）。
- 不做通用的多代理编排框架（DAG、角色、交接）；第一阶段只有「派一个、等结果」。
- 不改编程助手自己的子代理机制（那是 [cli-subagents.md](cli-subagents.md) 的范围）。

## 2. 业界做法（调研 2026-10-24）

| 做法                    | 代表                                                                                                | 要点                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| CLI 自己当 MCP 服务器   | Codex `codex mcp-server`（OpenAI 官方指南：配合 Agents SDK）                                        | 两个工具：`codex()` 开会话、`codex-reply(threadId)` 续聊；主代理把它当普通工具调用 |
| 第三方 MCP 包装多个 CLI | subagent-mcp（Claude Agent SDK + `codex app-server`）、cli-agent-mcp、mcp-subagents、Sub-Agents MCP | 一个接口调多个 CLI；有的限制并发（每种 5 个）；主代理先拆任务再分派                |
| 编排面板                | Vibe Kanban                                                                                         | 人分任务、每个任务一个 git worktree 并行跑；自身也是 MCP 服务器                    |
| 统一控制接口            | agentapi（Coder）                                                                                   | HTTP 控制多个 CLI；提醒要做访问控制                                                |

结论：这些方案要从头解决会话驱动、审批、账号、显示；Nomi 的编程助手服务（`CliHarnessService`）已经全部具备。
所以**不走 MCP，直接在主进程里把「开标签 → 发消息 → 等这一轮结束」包成 Nomi 的一个工具**。

结构上采用业内主流的「主代理 + 工人」（Claude Code 子代理、Agents SDK 的 agents-as-tools、Anthropic 多代理调研系统），
并借鉴三点：任务说明要具体（§4.1 拆字段、§4.4 模板）；子代理只交回结论、按固定格式汇报，大段产出写文件（§4.3）；
默认异步（P2，§9）。与它们不同的是子任务是用户看得见、能接手、能单独停止的真实标签（§7）。

## 3. 用户看到什么

1. 用户：「让 Codex 在 ~/code/app 里把登录 bug 修了」。
2. Nomi 调用 `delegate_to_cli`。按权限模式（§5）可能先弹确认：「让 Codex 在 ~/code/app 里执行：修复登录 bug？」
3. 确认后新开一个编程助手标签（后台标签，不抢焦点），标题带「由 Nomi 派出」标记；Nomi 的对话时间线里出现一张
   **子任务卡片**：编程助手图标、任务摘要、工作目录、账号 / 供应商、当前步骤、运行状态与耗时、「查看」「停止」按钮。
4. 编程助手需要审批时，**审批直接显示在这张卡片里**，在卡片上就能允许 / 拒绝（工作台模式下标签里也照常显示）。
   编程助手的审批 120 秒不答复会自动拒绝（§11.1），所以不能只靠用户切到标签去看。
5. 完成后卡片变为完成状态；Nomi 拿到结果摘要（§4.3），继续回复用户：「Codex 改了 3 个文件……」。
6. 用户可以随时点「查看」看完整过程（两种模式的做法见 §7.1）；在标签里自己发了消息就算接手，
   那之后这个标签归用户，Nomi 不再往里发消息。

助手模式和工作台模式都能用这个功能，区别只在「查看」怎么打开（§7.1）。

## 4. 接口

### 4.1 工具

注册位置：`electron/src/desktop/plugin.ts`（与桌面工具一起进 ToolRegistry）。实现放在新的
`electron/src/cli/delegate/`，只依赖 `CliHarnessService` 的公开方法。

```ts
delegate_to_cli({
  cli: 'claude' | 'codex' | 'grok' | 'gemini' | 'dsh' | string, // 外部 CLI 用插件 id
  // 任务说明拆成几项，迫使 Nomi 写清楚（不能只写「修一下」），见 §4.4
  goal: string,           // 要做成什么
  context?: string,       // 已知的背景：相关文件、报错、用户原话
  done_when: string,      // 完成标准：怎样算做完（如「npm test 通过」「只改登录相关文件」）
  out_of_scope?: string,  // 不要碰的范围
  cwd?: string,           // 缺省：最近使用的工作目录；必须在桌面权限已授权的范围内（§6.2）
  background?: boolean,   // 默认 true（异步）；false 同步等到结束
  profile?: string,       // AgentProfile id（default / cheap / local / 自定义）；缺省用设置默认档位
  model?: string,         // 覆盖子 CLI 模型（优先于 profile）；第三方「供应商/模型」，官方 CLI 原生名
  reasoning_effort?: string, // 覆盖思考深度
}) → DelegateResult

delegate_followup({ taskId, message }) → DelegateResult   // 第二阶段：在同一个标签里接着问
delegate_status({ taskId }) → DelegateStatus              // 第二阶段：查后台任务
```

可用的 `cli` 只列出已安装、可用的编程助手（工具描述在注册时生成，和 `bins` 一致）。

### 4.2 执行流程（同步）

```
Nomi 工具循环
  └─ delegate_to_cli.execute(input, ctx)
       1. 校验：cli 可用、cwd 已授权、委派层数（§6.4）
       2. PermissionBroker.authorize(tool: 'delegate_to_cli', danger: 'write')   ← 按 Nomi 权限模式
       3. harness.createTab({ backend, cwd, permissionMode: 子任务档位(§5), title, delegatedBy: 'nomi' })
       4. harness.sendTab(tabId, task)  ← 等这一轮结束（含后台子代理，见 cli-subagents.md §1.1）
          ctx.signal abort → harness.cancelTab(tabId)
       5. 汇总结果（§4.3），标记受污染轮次（§6.3），返回
```

### 4.3 返回给 Nomi 的结果

只返回结论，不返回完整过程，避免撑爆 Nomi 的上下文。编程助手按固定格式汇报（§4.4），主进程解析成结构化字段；
解析不出来时退回「最后一段回复」：

```ts
interface DelegateResult {
  taskId: string; // = 标签 id
  cli: 'claude' | 'codex' | 'grok' | 'gemini' | 'dsh';
  status: 'running' | 'done' | 'error' | 'cancelled'; // 默认后台委派首次返回 running
  cancelledBy?: 'user' | 'nomi'; // 用户在卡片上停的，还是 Nomi 这一轮被停连带停的
  report?: {
    done: string; // 做了什么
    changedFiles: string[]; // 改了哪些文件（与 git status 交叉核对，最多 50 个）
    unfinished?: string; // 没做完的
    needsUser?: string; // 需要用户决定的
  };
  conflictedFiles?: string[]; // 主工作树已有改动、因此没有自动覆盖的文件
  summary: string; // report 解析失败时：最后一段回复，截断到约 4000 字符
  filesVerified: boolean; // 是否通过 git status 核对过改动文件
  approvals?: { asked: number; denied: number; timedOut: number }; // 审批统计（§5.1）
  error?: string;
  durationMs: number;
  usage?: HarnessUsage;
  isolationNote?: string; // worktree / shared-cwd 隔离说明
}
```

- `taken_over`：用户在委派标签中发送消息时，主进程先取消当前委派轮次，等待标签回到空闲，再把标签归用户；取消失败或超时不会伪造接管状态。
- 大段产出（调研结论、长日志）让编程助手写进工作目录里的文件，`report` 里只给路径，不经 Nomi 的上下文传递。

### 4.4 发给编程助手的消息

主进程用固定模板把 §4.1 的几项拼成发给编程助手的第一条消息，末尾要求按格式汇报：

```
你在帮 Nomi（用户的桌面助手）完成一项任务。
目标：{goal}
背景：{context}
完成标准：{done_when}
不要碰：{out_of_scope}

做完后，最后一条回复只按下面的格式输出（标记原样保留）：
[nomi-report]
做了什么：…
改动的文件：每行一个相对路径
没做完的：…（没有就写「无」）
需要用户决定的：…（没有就写「无」）
[/nomi-report]
```

`[nomi-report]` 块解析失败、或改动文件和 `git status` 对不上时，以 `git status` 为准，并在结果里注明。

### 4.5 子任务怎么启动：编程助手的主会话 + 默认配置

每次委派都是**新开一个普通的编程助手标签**，跑的是该 CLI 的主代理（顶层会话），不是挂在用户已有会话下的
子代理，也不复用用户已经打开的标签（避免打断用户正在进行的对话）。配置全部沿用「新标签」的默认值，
Nomi 不另外指定：

| 配置                  | 取值（`createTab` 现有逻辑）                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 来源（官方 / 第三方） | 「模型」页给这个编程助手设的「新标签默认用」（`defaultSource`）                                                                      |
| 官方账号              | 当前默认账号                                                                                                                         |
| 模型、思考深度        | 工具 `model` / `profile` / 设置默认档位（见 §12.3）→ 否则这个编程助手最近一次的设置（`inheritSettings`）                             |
| 权限模式              | 新标签默认档，再按 §5 限制在 Nomi 当前档位以内                                                                                       |
| 工作目录              | `cwd` 参数，缺省为最近使用的目录                                                                                                     |
| CLI 自己的配置        | 和用户直接开标签一样：`~/.claude`、`~/.codex` 里的设置、项目说明文件（CLAUDE.md / AGENTS.md）、用户给 CLI 配的 MCP 与 hooks 都会生效 |

要改的一处：`createTab` 现在会把新标签设为当前标签（`activeTabId = tab.id`），委派时会抢走用户正在看的界面。
需要加一个 `activate: false` 选项，委派开的标签在后台创建，不切换。

CLI 配置里如果接了 Nomi 的 MCP，子任务就有可能回头调用 Nomi，靠 §6.4 的层数限制挡住。

### 4.6 用命令指定交给哪个编程助手：`/agent`（`/cli` 为隐藏别名）

用户可以在 Nomi 对话里**显式指定**下一个需求交给哪个编程助手，不让 Nomi 自己选。**规范命令是 `/agent`**；`/cli` 仍可用，行为相同，但不在帮助 / 补全里强调。

| 输入                           | 效果                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `/agent codex 修复登录 bug`    | 立即发出：Nomi 把「修复登录 bug」整理成任务说明（§4.1）交给 Codex                |
| `/agent codex`                 | 输入框上方出现「下一个需求交给 Codex ×」；下一条消息按上一行处理，发出后自动取消 |
| `/agent`                       | 列出可用的编程助手（已安装、可用的）与当前指定                                   |
| `/agent off`（或点 chip 的 ×） | 取消指定                                                                         |
| `/cli …`                       | 与 `/agent …` 相同（隐藏别名）                                                   |

- **主进程钉住**：发送时渲染层先调 `ai:delegate:pin`（编程助手 id，绑定这一轮），`delegate_to_cli` 执行时用钉住的
  编程助手覆盖模型给的 `cli` 参数，用一次即清除；这一轮结束没用上也清除。模型改不了用户的指定。
- 发给 Nomi 模型的消息前面加一句说明（「用户指定把下面的需求交给 Codex 完成，请调用 delegate_to_cli」），
  界面上只显示用户原文和一个「交给 Codex」小标记。
- 名字匹配不区分大小写，接受别名（`claude-code`、`cc` → Claude Code）；未安装的编程助手直接提示，不发出。
- 权限照常：指定只决定交给谁，不跳过 §5 的确认和档位限制。

### 4.7 设置：按任务类型配置默认编程助手

设置 →「编程助手」页加一个「委派」分页（与「助手」「监视与会话」并列）：

| 设置项                 | 说明                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| 允许 Nomi 委派编程助手 | 总开关，默认开；关掉后 Nomi 不注册 `delegate_to_cli`，`/agent`（及 `/cli`）提示已关闭 |
| 编程开发               | 默认交给哪个编程助手（下拉：已安装的编程助手 +「让 Nomi 选」）                        |
| PRD / 需求文档         | 同上                                                                                  |
| 代码审查               | 同上                                                                                  |
| 调研分析               | 同上                                                                                  |

- `delegate_to_cli` 增加参数 `kind: 'coding' | 'prd' | 'review' | 'research'`（缺省 `coding`），由 Nomi 按需求判断。
- **选谁的优先级**：`/agent`（或 `/cli`）钉住的（§4.6）> 用户在消息里点名的（模型据此填 `cli`）> 这个任务类型的默认 >
  「编程开发」的默认 > Nomi 自己从已安装的里选。工具描述里写明：用户没点名时不要填 `cli`。
- 默认值都是「让 Nomi 选」；设成的编程助手被卸载后，按「让 Nomi 选」处理并在设置里标出。
- 存在主进程（`userData/delegate/settings.json`），经 `ai:delegate:settings` / `ai:delegate:set-settings` 读写。

## 5. 权限

子任务的权限**不能比 Nomi 当前的档位宽**：

| Nomi 的档位 | 派出子任务前                                            | 子任务标签的档位                                   |
| ----------- | ------------------------------------------------------- | -------------------------------------------------- |
| 计划        | 直接拒绝（`mode_blocked`）                              | 不派出。想要只读调研，第二阶段可以允许派「计划」档 |
| 逐项确认    | 每次确认                                                | 逐项确认（不支持的 CLI 按现有规则降级到计划）      |
| 自动改文件  | 按 `delegate_to_cli` 的策略（默认「每次运行首次确认」） | 自动改文件                                         |
| 自动        | 不确认（单独设过策略的除外）                            | 新标签默认档，但不超过「自动」                     |

- 「完全放开」永远不会经委派进入；`createTab` 本来就拒绝继承 bypass。
- 确认对话框里写清楚：哪个编程助手、哪个目录、用哪个账号 / 供应商、任务原文。
- 编程助手自己的审批照常走它的审批卡片（含并行审批队列），Nomi 不能替用户批准（§5.1）。

### 5.1 编程助手要审批时

1. **来源**：Claude（`can_use_tool`）、Codex（app-server 审批请求）、Gemini / Grok / 外部 CLI（ACP
   `session/request_permission`）的权限请求照常进该标签的审批队列，带上发起的子代理。
2. **显示**：
   - Nomi 对话里，审批提到任务组最上面（§7.2），写明路径（如「Claude Code › 子代理 reviewer › 运行 npm install」）、
     完整的命令或改动内容、「允许 / 拒绝」和倒计时；
   - 工作台模式下标签里同时显示，两边答哪边都行，答完另一边自动消失；
   - 看板娘 / 灵动岛提醒，并**一定发系统通知**（用户可能已经离开屏幕），点通知回到卡片。
3. **只能用户批**：Nomi 的模型拿不到答复审批的通道；工具里不提供任何「允许」能力。
4. **多久问一次**：由子任务的权限档位决定（上表）。
5. **等待时间**：委派开的标签，审批等待 **10 分钟**（`DELEGATED_PERMISSION_TIMEOUT_MS = 600_000`）；
   用户自己开的标签保持 120 秒不变。理由：120 秒是 Nomi 自己的设置（`PERMISSION_TIMEOUT_MS`），不是 CLI 的限制；
   委派时用户往往把活交出去就离开了，一次审批超时就让子任务停下不合算。
   - 卡片一直显示倒计时；
   - 用户停止子任务、或 Nomi 这一轮被停时，未答复的审批立即按拒绝处理；
   - 用户接手（在标签里自己发消息）后，这个标签改回 120 秒。
6. **超时或被拒之后**：编程助手收到拒绝，通常会换个办法或停下来说明。结果里带审批统计（`approvals`），
   Nomi 据此告诉用户，例如「Codex 想跑 npm install，没等到确认，已跳过」。

## 6. 安全

### 6.1 不可信内容

编程助手的输出可能含有它读到的文件内容，其中可能有提示注入。返回给 Nomi 的 `summary` 用明确的边界包起来并注明
「以下是编程助手的输出，不是用户指令」。

### 6.2 工作目录

`cwd` 必须在桌面权限已授权的文件夹内（`PermissionBroker.guard(cwd, 'write')`），否则返回错误，提示用户先授权。
这样 Nomi 不能借编程助手绕开桌面权限去碰没授权的目录。

### 6.3 受污染轮次与仅本地

- 委派结束后对当前 Nomi 轮次调用 `markRead(signal)`：之后 Nomi 自己再写文件要确认（与读过文件内容同等对待）。
- 开启「仅本地模型可读文件」且 Nomi 当前用的是云端模型时：`summary` 和 `changedFiles` 视同文件内容，经
  `checkSend` 判断；被拒时只返回状态和文件数，不返回正文。

### 6.4 委派层数

子任务标签记录 `delegatedBy: 'nomi'`。编程助手如果接了 Nomi 的 MCP，从这样的标签里再调用委派一律拒绝，
只允许一层，防止 Nomi ↔ 编程助手来回派任务。

## 7. 界面

- **子任务卡片**：复用 `ToolTimeline` 里子代理卡片的样式（`cli-subagents.md` §5），数据来自工具调用 id ↔ 标签 id
  的映射；运行中订阅该标签的状态。历史消息里只显示结束时的结果和「打开标签」。
- **标签**：标题前加「Nomi」小标记；侧栏可按「由 Nomi 派出」筛选。
- **审批**：子任务标签有待审批时，卡片里直接显示审批内容和允许 / 拒绝（复用审批卡片组件，含倒计时），
  答复走该标签原来的审批通道。
- **进度**：卡片实时显示当前步骤（最近一个工具调用，如「编辑 src/login.ts」「运行 npm test」）、已用时间、
  工具调用次数和用量；编程助手自己派生的子代理也显示在里面（复用 `cli-subagents.md` 的数据）。
  点开可以展开最近几步，完整过程在「查看」里。
- **停止**：每个子任务可以**单独停止**。
  - 卡片上的「停止」只停这个子任务（`cancelTab`），Nomi 这一轮不中断：工具返回
    `status: 'cancelled', cancelledBy: 'user'`，Nomi 接着回复用户（如「已按你的要求停下，Codex 停下前改了 2 个文件」）。
  - Nomi 这一轮的「停止」会连带停掉它派出的、还在运行的子任务（`cancelledBy: 'nomi'`）。
  - 在编程助手标签里点停止，效果和卡片上的「停止」一样。
  - 第三期并行时每个子任务一张卡片，各自停止。
- **看板娘 / 灵动岛**：子任务完成、出错、等审批时照常提醒（编程助手服务已有的 `tab-finished` /
  `permission-needed` 通知），提醒文案带上「Nomi 派出的」。

### 7.1 助手模式与工作台模式

两种模式都开放委派。助手模式隐藏了标签栏（后台标签照常运行），所以卡片要能独立完成大部分操作：

|                  | 助手模式                                                            | 工作台模式                   |
| ---------------- | ------------------------------------------------------------------- | ---------------------------- |
| 子任务标签       | 后台运行，不显示标签栏                                              | 出现在标签栏，带「Nomi」标记 |
| 卡片上的「查看」 | 在侧边抽屉里打开该标签的对话记录（只读 + 可发消息接手），不切换模式 | 切到该标签                   |
| 审批             | 卡片里                                                              | 卡片里 + 标签里              |
| 运行中计数       | 模式切换旁的「N 运行中」包含 Nomi 派出的子任务                      | 标签栏状态点                 |

抽屉复用编程助手标签的对话组件，只是装在抽屉里；关闭抽屉不影响子任务运行。

### 7.2 同时派出多个编程助手，各自又有子代理

例如 Nomi 同时派 Claude Code 和 Codex，两者各自派生子代理，一共三层：Nomi → 编程助手 → 子代理。
两家给的子代理信息不对等（来自 [cli-subagents.md](cli-subagents.md)）：

|          | Claude 子代理              | Codex 子代理                 |
| -------- | -------------------------- | ---------------------------- |
| 内部步骤 | 有                         | 没有，只有交给它的任务和结果 |
| 进度     | 最近工具 · 工具次数 · 耗时 | 只有状态                     |
| 单独停止 | 可以（`stop_task`）        | 不行                         |

原则：**Nomi 对话里最多三层，每层一行；子代理内部的每一步只在「查看」里看**（标签或抽屉里已有完整的嵌套显示）。

```
┌ Nomi 派出 2 个任务 · 1 运行中 · 1 等你确认 ──────── [全部停止] ┐
│ ⚠ 等你确认：Claude Code › 子代理 reviewer › 写 src/auth.ts      │
│              [允许] [拒绝]                         1:42 后自动拒绝 │
│                                                                  │
│ ◉ Claude Code · 修复登录 bug                 运行中 · 3:12 [停止] │
│   当前：explorer · 运行 npm test                                 │
│   ▾ 子代理 3 个（2 运行中）                                      │
│     ├ explorer   运行中  Bash · 7 次工具 · 1:05          [停止]  │
│     ├ reviewer   等确认  Write · 2 次工具 · 0:40         [停止]  │
│     └ planner    已完成  0:22                                    │
│                                                    [查看]        │
│ ◉ Codex · 补充登录接口的测试                 运行中 · 2:30 [停止] │
│   当前：派出子代理 worker-1                                      │
│   ▸ 子代理 2 个（Codex 不提供子代理内部步骤）                    │
│                                                    [查看]        │
└──────────────────────────────────────────────────────────────────┘
```

- **第一层（任务组）**：同一轮派出多个任务时合成一组，组头汇总状态，有「全部停止」；只有一个任务时不显示组头。
  所有审批提到组的最上面，用路径标明来源（编程助手 › 子代理 › 操作），带倒计时；复用现有的多项审批队列。
- **第二层（每个编程助手）**：默认收起；「当前」一行显示所有代理里最近的一个动作并注明是谁
  （「explorer · 运行 npm test」），不展开也知道在做什么。Claude 的后台子代理还在跑时显示
  「主代理已回复，等 N 个后台子代理」，任务不算完成，Nomi 继续等。
- **第三层（子代理）**：每个一行，不再往下展开。Claude 显示类型、状态、进度和「停止」；Codex 只显示状态和任务，
  「不提供内部步骤」只在组里说明一次。子代理多时只显示运行中和等确认的，已完成的折叠成「另有 N 个已完成」。
- **停止分三级**：全部停止 → 单个编程助手 → 单个子代理（仅 Claude）。都不中断 Nomi 这一轮，Nomi 收到哪些被停了。
- **交回 Nomi 的内容**：不含子代理细节，汇报里只多一句「用了 N 个子代理」。
- **提醒**：看板娘 / 灵动岛按编程助手（第二层）提醒完成、出错、等确认，不按子代理提醒，避免并行时刷屏。
- **无障碍**：整组是 `role="tree"`，方向键展开 / 收起；`aria-live="polite"` 只播报第二层的状态变化。

数据来源：第二层来自标签状态，第三层来自标签的 `LiveAgent`（`cli-subagents.md` P1 / P2 已实现），
审批来自标签的权限队列；委派只需要维护「工具调用 id → 标签 id」的映射。

## 8. 成本与用量

- 卡片和确认框都写明用的是哪个账号 / 供应商（官方订阅额度还是第三方 Key）。
- 子任务的用量照常进「用量与费用」和「模型质量」的 CLI 层记录；记录上加 `delegatedBy: 'nomi'` 便于区分。
- 预算：子任务的用量算在对应编程助手名下；「用量与费用」里设了预算且已超出时，委派直接失败并说明原因
  （现有预算是按什么维度设的，实现前要再核对）。

## 9. 分阶段

| 阶段 | 内容                                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | 同步、单个子任务；§5 权限、§6 安全、§7 卡片（含卡片内审批）与停止；助手模式与工作台模式都开放（§7.1）                                                                                                                              |
| P2   | ✅ `background`（**默认 true**）、`delegate_followup`、`delegate_status`；完成后广播 `ai:delegate:completed`，对话注入结果，卡片 live 更新；任务状态落盘到私有 `tasks.json`，重启时运行中任务标记为中断。`background:false` 可同步 |
| P3   | ✅ 并行：git 仓库内每个子任务一个 worktree（`.nomi-delegate/`）；非 git 则 shared-cwd + 提示；结束后拷回主树；并发上限 `MAX_PARALLEL_DELEGATES`（3）                                                                               |

## 10. 测试

- 单元：权限映射表（§5 每一格）；cwd 未授权被拒；层数限制；`summary` / report 字段 untrusted 边界；abort → `cancelTab` /
  孤儿标签清理；仅本地 + 云端模型时不返回正文；任务状态持久化与重启中断；用户接手时取消并等待标签回到 idle；worktree 回填冲突不覆盖主工作树。
- 无界面 E2E：用 mock CLI 后端跑一次完整委派，断言新标签、结果回到 Nomi、用量记录带 `delegatedBy`。
- 真实应用 E2E：卡片显示、停止、跳转审批。

## 11. 已查证与待确认

### 11.1 长任务的时间限制（查证 2026-10-24）

结论：**没有会打断同步等待的硬超时**，P1 可以按同步实现。

| 环节                  | 现状                                                                                                                                                              | 对委派的影响                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Nomi 工具循环         | `AiSdkLlmProvider` 用 AI SDK 的 `streamText`，工具执行没有超时，只受 `abortSignal`（用户停止）控制；`GuardrailsPlugin` 的 15 秒工具超时没有装配（`igPlugins.ts`） | 可以无限等；停止能传到工具（`ctx.signal`）                                   |
| 工具循环步数          | `stopWhen: stepCountIs(maxSteps ?? 5)`，Nomi 对话没有另外设置                                                                                                     | 一轮里委派 + 追问 + 回复要在 5 步内；P2 的多次追问可能要放宽                 |
| 网关                  | 首字节超时只管到响应头；流的空闲超时 180 秒（`gateway/src/timeouts.ts`）                                                                                          | 不影响：工具执行时，上一步的模型请求已经结束，没有挂着的请求；下一步是新请求 |
| 主进程 → 对话窗口的流 | `IPCTransportServer` 只按帧合并文本，没有空闲超时；窗口关闭才停上游                                                                                               | 不影响；关掉对话窗口会停掉 Nomi 这一轮，进而停掉子任务（符合预期）           |
| 对话窗口              | 没有「多久没收到数据就报错」的看门狗                                                                                                                              | 不影响                                                                       |
| 编程助手的审批        | `PERMISSION_TIMEOUT_MS = 120_000`，2 分钟不答复自动拒绝                                                                                                           | **有影响**：审批必须显示在卡片里（§7），委派开的标签等待改为 10 分钟（§5.1） |
| Gemini                | 一轮 5 分钟没有任何输出判定卡死并取消（`GEMINI_PROMPT_IDLE_MS`）                                                                                                  | 和直接用 Gemini 标签一样；结果以 `error` 返回                                |

P1 曾按同步实现；P2 起默认异步（`background !== false`），派出后立刻返回 `status:'running'`，
Nomi 可继续聊；完成后广播 + 对话通知。需要同步等结果时传 `background:false`（abort 仍连带停子任务）。

### 11.2 待确认

1. **默认派给谁**：用户可用 `/agent`（或 `/cli`）显式指定（§4.6）；没指定时 Nomi 自己选，还是设置里指定一个默认编程助手，待定。
2. **改动文件列表的来源**：已定为编程助手的汇报（§4.4）+ 结束时 `git status --porcelain` 核对；
   目录不是 git 仓库时只用汇报，并注明未核对。
3. **预算的维度**：§8 的「超出预算时委派失败」要先核对现有预算是按什么维度设的。

## 12. 实现记录与偏差（P1）

实现：主进程 `electron/src/cli/delegate/`（`core.ts` 纯逻辑、`DelegateService.ts` 工具 / 设置 / `/agent` 钉住），
编程助手服务加了 `createTab({ activate, delegation })`、委派标签的审批等待与统计、`HarnessStoppedError`；
渲染层 `Conversation/DelegateCard.tsx`（卡片 / 任务组 / 抽屉）、`ProvidersPage/DelegateSettings.tsx`、
`slash/adapters/nomi.ts`（`/agent`，`/cli` 隐藏别名）、`services/delegateClient.ts`。工具调用 id 经 `ToolExecContext.toolCallId` 传到工具。

与上文的差异：

- **总开关关闭时工具仍注册**（§4.7 写的是不注册）：工具在 AI 运行时启动时一次注册，运行中改开关不重建工具表；
  关闭时调用直接返回 `delegate_disabled`。
- **审批在每张子任务卡片里**，没有提到任务组最上面（§7.2）；任务组头部只汇总「N 等你确认」。
- **系统通知**沿用编程助手进度监视的设置（委派标签在后台创建，按后台标签处理；关了系统通知就只有看板娘 / 灵动岛）。
- **外部 CLI 暂不能委派**，只有内置的 Claude Code / Codex / Grok / Gemini / dsh。
- **改动文件**：开工前后各取一次 `git status`，只算这次新出现的（开工前已改过的文件，只有编程助手汇报里提到才算）。
- **停止子任务时未答复的审批**随这一轮一起作废（CLI 被中断、计时器清除），不单独回一个「拒绝」。
- **汇报标记用 `[nomi-report]`** 而不是 `<nomi-report>`：对话界面的 Markdown 不渲染 HTML（`skipHtml`），
  尖括号标记会让整段汇报在编程助手标签里看不见（真机 E2E 发现）。
- **单独停止子代理**按插件能力位 `subagentStop` 判断（目前只有 Claude），不按名字。
- `/agent`（旧名 `/cli`）钉住按 **conversationId（渲染层）+ turnId/reqId（主进程）** 隔离，不再是进程级；
  发送时先 IPC 钉住，失败则中止发送；cwd/授权通过后才 consume；本轮结束 `clearPin`（未委派也不泄漏）。
- **`taken_over`**：`tab-send` 的用户路径会先取消运行中的委派轮次并等待它回到 idle，再接受用户消息；空消息、图片能力校验等输入错误发生在接管前，不会误标记标签归用户。委派侧收到 `HarnessStoppedError` 后按 `cancelled` 收尾，后续 `delegate_followup` 返回 `taken_over`。
- 汇报 `done` / `unfinished` / `needsUser` 与 `summary` 一样包 `<cli-output>` untrusted 边界（§6.1）；
  改动文件用 `git rev-parse --show-toplevel` + `status --porcelain -z`（`core.quotepath=false`），路径相对委派 cwd；
  汇报缺失时仍通过结果里的 `changedFiles` 交回 git 列表。
- 委派层数（§6.4）：`ctx.callerTabId` 对应标签的 `delegation.by === 'nomi'` 时拒绝（`delegation_depth`）。
- 生产路径：`runWithToolCaller`（ALS）+ `mapTools`/`ChatRequest.extra.callerTabId`，使嵌套 `delegate_to_cli` 在 MCP/host 包一层后也能读到 caller（不仅单测显式传 ctx）。

### 12.0 P2 异步委派（已实现）

- **默认 `background: true`**：`delegate_to_cli` 开标签后立刻返回 `{ status:'running', taskId }`；子任务在 `BgTask` Map 里跑完，`finalize` 后广播 `ai:delegate:completed`。
- **`background: false`**：同步等到结束；Nomi 本轮 abort 仍 `linkAbort` 连带 `cancelTab`。异步模式下派出后本轮结束**不**连带停（卡片「停止」仍可 `cancelTab`）。
- **`delegate_status` / `delegate_followup`**：查状态；跟进时若仍 running 返回 `busy`；跟进本身同步等。
- **UI**：`DelegateCard` 在工具输出为 running 时跟标签 live，并订阅完成广播 / `ai:delegate:status` 刷新汇报；`AiChatContext` 把完成结果注入对话（与日程结果同路径）。
- **不变**：层数限制、pin 按 turnId、abort 孤儿清理（派出前）、`<cli-output>` untrusted 边界。

### 12.1 明确推迟（v2.0.0 不实现）

| 项                                                    | 说明                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| 完整拆分 `CliHarnessService`（约 4886 行）            | 归入插件化 M5；本版本不拆                                   |
| Permission PR3 ExitPlanMode UX                        | 权限模式后续 PR                                             |
| LFS **历史 rewrite**（filter-repo / migrate rewrite） | 不做；改用 `migrate import --no-rewrite` + `.gitattributes` |

- `createTab` 与后续 await 之后、`sendTab` 之前若 `ctx.signal` 已中止：`closeTab` 清理孤儿标签并返回 `cancelledBy: 'nomi'`。

### 12.2 P3 worktree 隔离（已实现）

- 实现：`electron/src/cli/delegate/worktree.ts`；`DelegateService.delegate` 在 `createTab` 前 `prepareIsolation`。
- **git 仓库内**：`git worktree add --detach <sourceCwd>/.nomi-delegate/<id> HEAD`；`createTab` 的 cwd 指向 worktree。
  结束后（非 cancel）`applyWorktreeToMain` 把改动拷回仓库根，**保留** worktree 供 `delegate_followup`；cancel / 授权失败则 `releaseIsolation`。
- **非 git**：`shared-cwd`，结果带 `isolationNote` 提醒并行会互相改文件。
- **并发上限**：同时 `running` 的委派 ≤ 3（`concurrency_limit`）。
- **不做 Docker**；子 CLI 自身 Seatbelt/沙箱仍生效。本地 `info/exclude` 写入 `.nomi-delegate/`。
- **已修复**：回填前检查主工作树对应路径；用户已有改动的文件不会被委派结果覆盖，并通过 `conflictedFiles` / `isolationNote` 返回。
- **残留风险**：成功任务的 `.nomi-delegate/` 会保留以支持 `delegate_followup`；应用重启时仍在运行的任务会标记为中断并异步清理其 worktree，已完成任务仍需后续清理策略。

### 12.3 A1 AgentProfile + 委派模型覆盖（已实现）

目标：前台 Nomi 用好模型，后台 `delegate_to_cli` 可指定便宜 / 本地档位，**仍是单层委派**（不做 planner/executor 二层）。

- 类型 `AgentProfile`：`{ id, label, model?, reasoningEffort?, preferLocal? }`。内置 `default`（不覆盖）、`cheap`（可用 `settings.cheapModel`）、`local`（`preferLocal` 元数据，工具白名单留给 B2）。
- 设置：`userData/delegate/settings.json` 增加 `defaultProfileId` / `profiles` / `cheapModel`；设置页「委派」增加默认档位与 cheap 模型一行。
- 工具参数：`profile?` / `model?` / `reasoning_effort?`。解析优先级：**显式 model > profile.model >（cheap→cheapModel）> 默认档位 > CLI 默认**。
- `createTab({ modelOverride, reasoningEffort })`：第三方路径模型须在网关目录，否则 `model_not_in_catalog`；未知档位 `unknown_profile`。
- **未做**：depth-2 planner、worktree 三路合并、完整工具白名单 profiles。
