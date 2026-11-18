# @nomi-ai/contract

## 0.1.2

### Patch Changes

- 35ca37e: feat(contract): 定时 / 持续任务的 `cli` 执行者在档位模式（`presetId`）下可以不传 `cli`，执行参数由内核按触发时的当前档位解析；显式执行者仍要求 `cli`。补齐公开契约里 `newTabSource` 与 `helperModel` 字段的说明（新会话默认来源与后台辅助请求模型）。 Tasks with a `cli` executor can omit `cli` when `presetId` is set; the kernel resolves the current preset at trigger time. Explicit executors still require `cli`. Also documents the public `newTabSource` and `helperModel` fields (default source for new sessions and the helper model for background requests).

## 0.1.1

### Patch Changes

- 5fe61e1: fix(workspace): 新增浏览器标签原生子视图的 `browserWindow.*` 契约（show / setRegion / navigate / reload / close / closeAll / sync，以及 loaded / closed 事件，仅限对话窗口调用）和相关中英文文案。 Add the `browserWindow.*` contract for the browser tab's native child view (show / setRegion / navigate / reload / close / closeAll / sync, plus loaded / closed events; chat window only) and the related zh/en strings.
- b27ece0: feat(cli): 新增 `cli.launcherGet` / `cli.launcherSet` / `cli.launcherTest`（仅限对话窗口，设置与测试标为 dangerous）以及本机登录、自定义启动命令的文案。 Add `cli.launcherGet` / `cli.launcherSet` / `cli.launcherTest` (chat window only; set and test are dangerous) and strings for local sign-in and custom launch commands.

## 0.1.0

### Minor Changes

- 1ec2af9: feat(contract): Agent 看板的契约：新增 `fleet.state`、`fleet.archive` 与 `fleet.changed` 事件（受管与外部 agent、占用与整机负载）；补上看板与负载指示的中英文案。/ Agent board contract: adds `fleet.state`, `fleet.archive` and the `fleet.changed` event (managed and external agents, usage and machine load); zh / en copy for the board and the load indicator.
- 0e6edc9: GitHub 连接：本机 gh 登录每个主机只能接一个（不能重复添加）；同一个账号再用令牌添加时可以选替换原来的或保留两个；gh 换了账号后，连接会说明当前账号并可以确认改用。
- a98d631: feat(contract): 桌面设置多了受保护文件夹 `protectedPaths` 与放行的环境变量 `cliEnvAllow`，新增 `desktop.protectFolder`、`desktop.unprotectPath`、`desktop.setCliEnvAllow`；补上相应的中英文案。/ Desktop settings gain `protectedPaths` and `cliEnvAllow`, with new `desktop.protectFolder`, `desktop.unprotectPath` and `desktop.setCliEnvAllow`; matching zh / en copy.
- 9ea9699: agent 页可以看到安装 / 更新要用的本机环境：Node.js 版本与路径、npm，以及当前 Node 满足哪些 agent 的最低要求（新增契约查询 `cliUpdate.environment`）。装到用户目录的 agent 不再被 PATH 上更早的旧版本挡住：装好后探测与启动都优先用它，重启后仍然有效；改用全局安装后恢复按 PATH 查找。Node 版与 Go 版一致。
- ba7efe1: feat(contract): 新增 `harness.sandboxReply`（回答沙箱授权请求：session / always / deny）、`desktop.setCliSandbox`、`desktop.removeCliSandboxAllow`；标签状态多了 `sandboxPending`，标签列表状态多了 `sandbox`（on / off / unsupported），桌面状态多了 `cliSandbox`、`cliSandboxSupported`、`cliSandboxAllow`；补上相应的中英文案。/ Adds `harness.sandboxReply` (answer a sandbox request: session / always / deny), `desktop.setCliSandbox` and `desktop.removeCliSandboxAllow`; tab state gains `sandboxPending`, the tabs state gains `sandbox` (on / off / unsupported) and the desktop state gains `cliSandbox`, `cliSandboxSupported` and `cliSandboxAllow`; matching zh / en copy.
- 4070aab: 运行中可以继续发消息，不会打断这一轮：Enter 把消息插入这一轮（下一个工具步骤交给 agent / Nomi），Ctrl/⌘+Enter 排队到这一轮结束再发。消息先显示在输入框上方的待发列表里，交出去之前可以撤回修改或删除；在输入框按 Esc 停止这一轮并把待发消息合成一条马上发出。插入的消息显示在回复中间。Claude Code、Codex、Grok 与 Nomi 对话支持插入，Gemini、dsh 暂时只能排队。Node 版与 Go 版一致。
- aa5a4cb: feat(computer-use): 契约新增 `computer.*`（状态、安装与更新、授权引导、设置、紧急停止、隔离沙箱、谁在操作桌面）与事件 `computer.activity` / `computer.changed`；确认请求的 `rememberGroup` 多了 `computer`。/ The contract adds `computer.*` (state, install and update, permission guide, settings, emergency stop, isolation sandbox, who is operating the desktop) and the `computer.activity` / `computer.changed` events; confirm requests' `rememberGroup` gains `computer`.
- 7abb8a5: `ai.chat.*`：消息新增 `context`（用户消息注入的背景）与 `steps`（上一轮工具循环的原样记录），流式块新增 `steps`；`mem.context` 新增入参 `exclude` 与返回 `ids`。
- 172670d: feat(contract): 新增 `project.*` 过程与 `project.changed` 事件；`harness.tabCwd` 换成 `harness.tabProject`，删除 `harness.setCwd` / `pickCwd` / `tabPickCwd`；`harness.tabCreate` 只收 `projectId`；`harness.gitDiff` 多返回 `gitRoot`。契约版本升到 3.0。
- 7abb8a5: `ai.chat.*` 的 `usage` 新增 `breakdown`（系统提示、工具定义、记忆、用户、助手、工具、思考，加起来等于 `contextTokens`）。
- 863dad7: 设置 → 外观新增「我的主题」：填强调色、背景、表面、文字 4 个颜色（或一次粘贴一组）即可新建主题，其余颜色自动推导并做对比度修正，编辑时实时预览；可以浅色、深色各配一套跟随系统切换，逐个调整颜色，加背景图；支持导入、导出主题包（`.nomitheme.json`，带背景图时为 `.nomitheme`）。
- ccbbfb9: fix(gateway): 故障转移看得见：网关重连 / 换供应商时发 `gateway.retrying`，Nomi 对话等待时显示「ProvA 返回 503，换到 ProvB 继续」；消息底部写实际回答的那一家（不再总写选中的那家）；不到 0.1 秒的耗时照实写，不再显示「0ms」。
- 1ec2af9: feat(contract): 新增 `fleet.pause`、`fleet.resume`、`fleet.setAutoPause`，看板状态带上内存压力；补上内存守护的中英文案。/ Adds `fleet.pause`, `fleet.resume` and `fleet.setAutoPause`, and the board state carries memory pressure; zh / en copy for the memory guard.
- 1ec2af9: feat(contract): 看板卡片的 `paused.by` 多了 `nomi`（Nomi 暂停的），新增 `held`（内存紧张时在待进行里排队）；补上排队、派出者等中英文案。/ Board cards' `paused.by` gains `nomi` (paused by Nomi) and a new `held` flag (waiting in To do while memory is low); zh / en copy for queueing, the dispatcher and more.
- 2029912: 新增「设置 → 外部连接」：可以复用本机 gh 登录或粘贴令牌连接 GitHub（令牌经系统加密保存，Nomi 不读取 gh 的令牌），宽权限会如实提示。任务可以授权只读查看指定仓库的 issue、PR、CI 与通知，对话里也能让 Nomi 查看；Nomi 也能在后台无界面地执行任务，需要你决定的操作会停下来等你批准。
- 25c09ad: feat(contract): 桌面设置多了命令白名单 `commandRules` 与 `desktop.removeCommandRule`，确认请求可带 `rememberRule`。/ Desktop settings gain the `commandRules` allowlist and `desktop.removeCommandRule`, and confirmation requests can carry `rememberRule`.
- a8eb3da: Nomi 的工具授权放进对话窗口：对话窗口开着时，写文件、跑命令等确认以授权卡片显示在输入栏上方（允许 / 拒绝 / 本次运行不再询问 / 查看详情），不再弹到诺米；诺米被关掉时打开对话窗口来问，不再把她叫出来；对话窗口没开时照旧由诺米问。Nomi 需要新文件夹时，对话里显示「请求访问文件夹」卡片（建议的位置、读 / 写、理由）：点「授权」直接生效，「选择其他文件夹…」才打开系统选择框；不存在、不是文件夹或范围太宽的位置不能直接授权。破坏性操作和云端首次发送提示直接展开详情，出现 1 秒后才能确认。Node 版与 Go 版一致。
- 568c407: Nomi 对话的上下文按模型优化：每轮带多少历史改为按实际路由到的模型的上下文窗口计算（为回答预留输出空间），不再固定 8K token；用到输入预算的 95% 时，发送前自动把较早的对话压缩成摘要（同其它 CLI），对话里显示一条可展开的「已压缩」分隔线；`/compact` 可随时手动压缩。新增契约查询 `gateway.nomiContext`。Node 版与 Go 版一致。

  工具循环每轮的步数上限从 5 步放宽到 20 步，读写文件等多步任务不再中途停下。

- c7f967c: feat(core): Nomi conversation workspaces. `ChatOptions.extra.cwd` reaches tools as `ToolExecContext.cwd` and is validated in the core (`PermissionBroker.workspaceOf`: a directory the user chose via `knownDir`, not a filesystem root, the home folder or its ancestors, Documents / Desktop / Downloads themselves, system folders or deny-listed paths); unknown workspaces are dropped. Desktop file tools use `guardIn` / `authorizeIn` inside a workspace and fall back to the user's granted scopes with the original authorization outside it (`guardWorkspaceOrGranted`, never auto-approved), `workspace_run` (`requiresWorkspace`, hidden by `toAiSdkToolSet` without a workspace) runs commands with the CLI tabs' environment, timeout, output cap and abort, and `delegate_to_cli` inherits the workspace. `HarnessOrchestrator` gets `autoApprove` (default on, `harness.permissionDefaults({ autoApprove })`, `HarnessTabsState.autoApprove`): new tabs default to `bypass` and keep it across restarts; tabs on the old default migrate once. Nomi's chosen workspaces now enter the recent-directory list. The default working directory is `<documents>/nomi`, created on first use; a persisted main-tab cwd equal to the old default (Documents) migrates to it.
- 89bbb9f: 新增「任务」：交代一次，Nomi 一直记着。侧栏会话列表上方多了「任务」入口（带「需要你」角标），可以新建按时间运行或手动运行的任务，授权卡片确认后才创建；任务停下来等你时（批准、补充信息、验收、核对）集中在「需要你」里处理，也可以暂停、取消、撤销授权。原来的提醒与定时任务一并列在任务页，点开仍在日程里编辑。
- d3d1914: feat(providers): 第三方供应商链接接入（docs/design/provider-link.md）：网页上的 `nomi://provider/import` 一键导入地址与 Key（兼容 Cherry Studio 的格式），`nomi://provider/connect` 走网页授权（PKCE，Key 不出现在链接里）；「设置 → 模型与供应商」可填网址发起授权。都要在 Nomi 里确认后才保存，同地址的更新已有的第三方供应商。Node 与 Go 两个版本一致。确认框只写能核实的来源（链接导入不显示链接自带的网站名）；开着代理软件 fake-ip 时也能授权；添加后自动拉取模型列表。
- 18b4428: feat(contract): 新增 `harness.messageAgent`（在子任务侧栏里直接对 CLI 子代理说话，结果带 `via` / `reason` / 关联标签 `tabId`）；`tasks.followUp` 接受 `images`（最多 8 张，可以只带图片）；补上直接对子代理说话的中英文案，删掉「后台 Nomi 追问只能发文字」。/ Add `harness.messageAgent` (message a CLI subagent directly from the side panel; the result carries `via` / `reason` / the linked `tabId`); `tasks.followUp` accepts `images` (up to 8, images alone are fine); zh / en copy for direct subagent messages, and drop the "text-only follow-ups" notice.
- f053e05: feat(contract): `tasks.trace` 列出每次执行（`attempts`，追问的原话在 `note`）和正在跑的那次写到一半的快照（`live`）；新增 `tasks.steer`（运行中插话）、`tasks.followUp`（结束后追问）和 `tasks.live` 事件（正文增量、工具步骤、插话）；补上侧栏追问与实时更新的中英文案。/ `tasks.trace` lists every attempt (`attempts`, with the follow-up text in `note`) plus a snapshot of the running one (`live`); add `tasks.steer` (interject while running), `tasks.followUp` (follow up after it ends) and the `tasks.live` event (text deltas, tool steps, interjections); zh / en copy for side-panel follow-ups and live updates.
- 8314ee7: 任务页多了看板视图：按进度（待开始 / 进行中 / 需要你 / 待验收 / 已结束）或按重要程度分列，可按类型筛选。任务可以设重要程度（紧急 / 高 / 中 / 低）和类型（编程、审查、调研、写作、盯着某处、杂事），新建时选，也能在详情里改；没选类型时按执行者自动判断。
- 1735daf: 持续任务可以交给已装好的 agent 执行：在独立的 git worktree 里改代码，审批按授权等级与命令分类判定（授权外直接拒绝、要人的进任务收件箱），完成后进验收，改动由你在验收卡片上点「回填到工作区」再拷回。Nomi 起草任务时也能选 agent 执行。
- 241125e: 持续任务可以由事件触发：网页 / RSS 有变化、GitHub 仓库的 issue / PR 动态或 CI 跑完、文件夹里有新文件、agent 一轮结束、知识库更新。新建的事件任务先只记录发现的事，你在任务详情里选择「处理这些」或打开「以后自动处理」。
- b4f9ec9: 持续任务可以做对外的动作了：在授权里逐项勾选「在 issue / PR 下评论」「从 nomi/ 分支开 PR」，或勾选本机 MCP 服务器的工具（只读之外的都算对外动作，属于最高授权等级）。每个对外动作执行前先记下意图；应用重启后不确定有没有发出去时，GitHub 评论和 PR 会先自动核对，查不了的在任务详情里列出来请你确认。事件触发也可以用 MCP 服务器的只读工具（如邮件、日历），有新条目就算一件事。只接本机（stdio）MCP 服务器。
- 4070aab: 工作台新增「执行轨迹」开发者工具：助手消息操作栏打开右侧抽屉，查看这一轮的时间线与耗时、工具调用的参数与输出、经过网关的模型请求（可看请求与响应正文）和 agent 子进程的原始收发，方便排查工具调用和任务执行问题。agent 标签与 Nomi 对话都支持，Node 版与 Go 版一致。

### Patch Changes

- bf74f72: fix(security): `harness.messageAgent` 标为 dangerous，且仅限对话窗口调用；补充命令审核会发送命令全文、以及没有系统沙箱时不会自动执行命令的文案。/ Mark harness.messageAgent as dangerous and chat-window-only, and add strings that command review sends the full command and that commands are not auto-run without an OS sandbox.
- 5a60967: fix(agent): `/agent 名字 需求` 直接派出 agent，派不出去时说明原因，不再由对话模型回一句当作已经交出。`NOMI_USE_MOCK_CLI=1` 从 `apps/desktop-go` 启动也能找到仓库里的假 CLI；假 CLI 不提供更新到正式版。新建任务的代码目录菜单不再被对话框挡住，新建任务默认改为手动运行。 / `/agent name request` starts the agent directly, and a failed handoff is explained instead of a normal reply that looks like success. `NOMI_USE_MOCK_CLI=1` finds the repo mocks when the app starts from `apps/desktop-go`. Mock CLIs are not offered an update to a real release. The code-folder menu in a new task is no longer hidden behind the dialog, and a new task defaults to run manually.
- 3cf04b1: feat(chat): 问题卡的契约事件与中英文文案（ai.userQuestion、看板「等你回答」）。/ Contract events and zh/en copy for the question card (ai.userQuestion, agent-board waiting state).
- ccbbfb9: feat(desktop): 桌面操作记录保留 30 天并分页显示，活动会话也分页。
- 5e21cdb: fix(character): 角色运行时判断 mapping 是不是 2.0.5 旧模板时带上包声明的表情（`AvatarMapping.set(mapping, expressions)`，`AvatarStage` 传 `character.capabilities.expressions`），与 validatePack 一致：声明了 `tears` 表情、把 `sad` 映射到它的自定义包不再被误判、整张映射被换成默认映射；没声明对应表情的 2.0.5 模板照旧回退。角色包快照（`character.getActivePack`）新增 `expressions`，覆盖包也把声明传给运行时（Node 与 Go 内核相同）。
- 9165114: feat(contract): 沙箱授权请求多了 `read`（读单个密钥文件）；沙箱「始终允许」的项可带 `project`；任务授权多了可选的 `sandbox`（预先允许的类别）；补上相应的中英文案。/ Sandbox requests gain `read` (a single secret file); "Always allow" entries can carry `project`; task grants gain an optional `sandbox` list of pre-allowed categories; matching zh / en copy.
- 2603f92: fix(cli): Codex 等 agent 登录报「device code request failed with status 403 Forbidden」——从 Finder / Dock 启动时 Nomi 拿不到终端配置（如 ~/.zshrc）里的 https_proxy，登录请求直连被官方服务按地区拒绝。现在读登录 shell 时一并读代理变量，加给 agent 的子进程（本机地址不走代理，网关不受影响），官方账号里新增「沿用终端里的代理」开关（默认打开）；登录被 403 拒绝时给出原因、检测到的代理和「沿用终端代理并重试」按钮。
- 7ad369f: fix(cli): `cliAccount.remove` accepts `stopExternal` and reports `ACCOUNT_EXTERNAL_BUSY` with the pids still using the account (see cli-thirdparty-effort-login).
- 16df054: feat(chat): 问题卡的来源加上 Codex 与 ACP。/ The question card's source now includes Codex and ACP.
- c0bc9ac: feat(chat): 上下文档位的契约字段与中英文文案

  网关选项增加 contextTier。模型设置里的档位说明，以及未识别模型按 256K 估算的提示，中英文都写上。

- 7ecf142: feat(contract): `harness.gitBranches` 列出本地分支，`harness.gitCheckout` 切换或新建分支（有会被覆盖的改动时返回 code dirty）。/ `harness.gitBranches` lists local branches and `harness.gitCheckout` switches to or creates a branch (code dirty when uncommitted changes would be overwritten).
- df95d1b: refactor(core): per-instance `CoreScope` (locale, verbose logging, private root, `CliTrace`) replaces module-level state; `ContractError` is matched by name and code; `persona.systemPrompt` returns the kernel-built prompt. `personaSchema` gains an optional `pronoun`, with `personaPronoun` / `pronounForms` helpers and neutral 它 / it defaults.
- 42dc378: feat(contract): 持续任务落地 worktree 的结果多了 `branch`（改动提交到的新分支）；cli 执行器多了可选的 `baseBranch`（基线分支）。/ Landing a task's worktree now returns `branch` (the new branch the changes were committed to), and the cli executor takes an optional `baseBranch`.
- 7200e84: fix(chat): 分叉没有项目的会话时，副本不再被归进当前打开的 Nomi 对话的项目（#308）。
- dd5eec9: feat(contract): 新增只在对话窗口可用的 `migration.chatHistory` 查询，交出 Go 版首启从 Electron localStorage 抽出的 `ai-chat:*` 键（`none` / `ready` / `failed`），供视图幂等导入旧对话（#181）；Node 版内核恒返回 `none`。
- 8559e9f: feat(contract): 新增 `history.deleteTab`（按标签当前的原生会话标识结束进程并删除记录，标为危险操作），供侧栏删除运行中的 agent 会话。/ Add `history.deleteTab` (stops the process and deletes the record by the tab's current native session id, marked dangerous) for deleting running agent sessions from the sidebar.
- 77062be: feat(island): 新事件 `nav.openItemRequested`：灵动岛上点「打开」时对话窗口跳到那一条。/ New event `nav.openItemRequested`: the chat window jumps to the item opened from the Dynamic Island.
- c004b2f: 灵动岛设置契约增加大、中、小尺寸枚举，旧响应默认大，并支持独立更新尺寸。
- 0211be6: feat(contract): 新增 `ext.mcpAuthorize`（dangerous）与 `ext.mcpClearAuthorization`；MCP 状态多了 `authorization-required`，服务条目可带 `oauthClientId`、`auth`、`hasAuthorization`；流式 `reasoning` 块可带可选的 `phase: start | end`。/ Adds `ext.mcpAuthorize` (dangerous) and `ext.mcpClearAuthorization`; MCP status gains `authorization-required`, server entries can carry `oauthClientId`, `auth` and `hasAuthorization`; streamed `reasoning` chunks take an optional `phase: start | end`.
- e916b9e: fix(tasks): 去掉预算拦截：任务的 `budget` 只剩 `maxRetries`，删除预算相关的文案。 / Remove budget interception: a task's `budget` only keeps `maxRetries`, and the budget strings are removed.
- ab0a3db: feat(chat): 契约与文案：确认卡片的「这个对话里不再询问」。/ Contract and copy for "Don't ask again in this conversation" on confirmation cards.
- 6de0750: fix(preview): 文件预览打开超过一小时后，保存会重新核对工作区和文件并换新的保存许可；文件被改过、换过或不再允许写入时不会覆盖，草稿可以复制或确认后放弃（#324）。 / After a file preview has been open for more than an hour, saving re-checks the workspace and the file and issues a new grant when the bytes are unchanged. An external edit, a replaced file, or a revoked permission is not overwritten, and the draft can be copied or discarded (#324).
- 0d9a30d: fix(cli): agent 正在运行时改了项目的文件夹，这一轮结束后按最新的项目同步——主文件夹变了就换工作目录（带上前文），其余文件夹变了就重启常驻进程，下一轮按新的文件夹工作；标签不再用项目或项目被删时也断开旧进程（#309）。
- 9e5b580: feat(contract): `gateway.upsertProvider` 的 `keys` / `newKeys` 可带 `note`（Key 备注，最多 200 字，空串清除）；补上 Key 备注、Agent 看板关闭标签与批量关闭空闲进程、提醒合并分隔符的中英文案。/ `gateway.upsertProvider` `keys` / `newKeys` accept `note` (a key note, up to 200 characters, empty clears it); zh / en copy for key notes, closing tabs and idle processes in bulk on the Agent board, and the merged-reminder separator.
- ab388c2: feat(cli): drop `cli.pluginAdd`, `cli.pluginRemove`, `cli.pluginTest`, the external CLI spec schemas and `harness.tabCreate`'s `pluginId` (see remove-external-cli).
- 010c6a1: feat(cli): official accounts no longer have a `local` flag and `ACCOUNT_LOCAL` is gone; every account is a Nomi-managed config folder (see remove-local-sign-in).
- 3197adc: feat(contract): 增加对话窗口专用的文件预览、目录、修订保存与外部资源契约，补齐预览与图片操作的主题令牌和中英词条。
- 6841bef: Chat usage chunks and agent messages can include `responseModel`: the model name an upstream provider returned when it is not the model that was requested. The turn footer explains that name in both languages.
- 86e2ebd: fix: add an optional source-edit flag to the resource preview open contract while preserving default preview behavior.
- d05e1ea: perf(memory): the local AI gateway process now starts on first use (sending a chat message, opening a CLI tab, enabling terminal commands) instead of at launch. Crash restart and the crash fuse work as before. The main process loads undici only when it makes its first upstream request. The contract IPC server can count a window's in-flight calls (`inflightFor`).
- bb0e8c8: feat(confirm): 确认请求新增 `sessionCommand`，`desktop.confirmAnswer` 新增可选的 `session`（本会话始终执行这条命令）。/ Confirm requests gain `sessionCommand` and `desktop.confirmAnswer` gains an optional `session` flag (always run this command in this conversation).
- 53a474c: feat(chat): 新增弹出的侧边聊天在窗口之间交接内容用的契约（`chatWindow.handoffPut` / `chatWindow.handoffTake`，只在内存里），以及「新侧边聊天」「侧边聊天 N」的文案。/ Add the contract for handing a popped-out side chat's content between windows (`chatWindow.handoffPut` / `chatWindow.handoffTake`, memory only), plus the "New side chat" and "Side chat N" strings.
- 85b017c: feat(chat): 新增标签弹出窗口的契约（`chatWindow.detachTab` / `detachedTabs` / `dockTab`，事件 `chatWindow.detachedChanged` / `chatWindow.tabDocked`），以及标签排序、向右拆分、在新窗口打开、放回主窗口和子任务悬停卡片的文案。/ Add the contract for popping side tabs out into their own window (`chatWindow.detachTab` / `detachedTabs` / `dockTab`, events `chatWindow.detachedChanged` / `chatWindow.tabDocked`), plus strings for tab reordering, split right, open in new window, move back to main window and the sub-task hover card.
- 4e2760c: `tasks.trace` 读出后台 Nomi 最近一次执行的工具步骤，供子任务侧栏使用。补上进程内子代理和后台 Nomi 在侧栏里的说明文案，并去掉不再使用的子任务输入框占位。 / `tasks.trace` returns the latest background-Nomi attempt's tool steps for the sub-task side panel. Add the side-panel notes for in-process subagents and background Nomi, and drop the unused sub-task composer placeholder.
- 88bcadc: feat(contract): `delegate.completed` 的结果可带 `followUp`（委派结束后在子任务里接着跑的一轮）；补上子任务面板的中英文案。/ `delegate.completed` results can carry `followUp` (a later turn in the sub-task after the delegation finished); zh / en copy for the sub-task pane.
- d511566: fix(core): normalize Windows 8.3 short vs long paths in knownDir / samePath / rememberCwd, and use native realpath for desktop workspace checks so quality and e2e-headed no longer fail with workspaceOf / invalid_path (E37). Declare autoApprove on HarnessTabsState.
