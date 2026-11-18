# @nomi-ai/i18n

## 0.2.2

### Patch Changes

- 93daf02: fix(i18n): 统一 agent 的措辞：中文正文、注释与文档一律用 agent（中文名词不分单复数），专有栏目名「Agents」「CLI Agents」「Agents 与账号」保留复数；英文沿用语法单复数，标题用「Agents」、正文用「agents」、指代个体用「each agent」。CLI 分组文案为「CLI Agents」。 Unify the agent wording: Chinese body copy, comments and docs use "agent" throughout (Chinese nouns carry no plural), while proper section names keep the plural ("Agents", "CLI Agents", "Agents & accounts"); English keeps its grammatical number — "Agents" in headings, "agents" in body copy, and natural phrasing such as "each agent" for a single one. The CLI group is labelled "CLI Agents".
- 9d1f087: fix(i18n): 续跑时执行配置与档位不一致的提示改为通用措辞：不再点名某个 agent、不再带占位符，也不再描述会发送账号或模型；说明已做的工作保留在工作目录、把档位改回上次的配置后点「继续」或新建任务。 Reword the "execution settings changed" message shown when a task resumes: it no longer names a specific agent, carries no placeholders and no longer hints at sending credentials; it says the work is kept and to restore the previous preset settings and choose Continue, or start a new task.
- 35ca37e: feat(i18n): 新增两条中英文提示：定时任务的执行档位已不存在或读取不到（`electron.common.task-config-preset-unavailable`），以及续跑时任务的执行配置（agent / 来源 / 账号 / 模型 / 思考深度）与上次不一致、不能接着旧标签跑（`electron.common.task-config-carrier-cli-changed`）。 Add two zh/en messages: a scheduled task's preset no longer exists (`electron.common.task-config-preset-unavailable`), and a resumed attempt whose preset now resolves to a different agent / source / account / model / effort than the previous one (`electron.common.task-config-carrier-cli-changed`).

## 0.2.1

### Patch Changes

- 5fe61e1: fix(workspace): 新增浏览器标签原生子视图的 `browserWindow.*` 契约（show / setRegion / navigate / reload / close / closeAll / sync，以及 loaded / closed 事件，仅限对话窗口调用）和相关中英文文案。 Add the `browserWindow.*` contract for the browser tab's native child view (show / setRegion / navigate / reload / close / closeAll / sync, plus loaded / closed events; chat window only) and the related zh/en strings.
- b27ece0: feat(cli): 新增 `cli.launcherGet` / `cli.launcherSet` / `cli.launcherTest`（仅限对话窗口，设置与测试标为 dangerous）以及本机登录、自定义启动命令的文案。 Add `cli.launcherGet` / `cli.launcherSet` / `cli.launcherTest` (chat window only; set and test are dangerous) and strings for local sign-in and custom launch commands.
- 61aa211: fix(chat): 新增「这一轮还没回复完 Nomi 就重启了」的中英文提示文案。Add the zh/en string for the card shown when a reply was interrupted by an app restart.
- 2958f64: feat(i18n): 补「极简」会话详细程度模式相关的中英文词条。

  zh/en copy for the "minimal" conversation detail mode.

- ebd40bf: fix(chat): 新增输入框被文件预览挡住时的中英文说明和「回到原会话」按钮文案。Add the zh/en notice shown when a file preview blocks the composer, and the "Return to conversation" button label.
- 1e23f1e: fix(chat): 新增中途插入消息在对话记录里的标记文案（「你加入了」已有；补上重启后跟进的中英文）。Add the zh/en label used when a mid-turn follow-up is recovered after a restart.
- 2958f64: feat(i18n): 补侧栏项目多 CLI 共享与悬停详情弹窗相关的中英文词条。

  zh/en copy for cross-CLI project sharing and the hover detail popover.

## 0.2.0

### Minor Changes

- 40ee48a: 右栏「改动」可以自己提交和推送了：提交区移到面板底部，写好提交信息点「提交改动」（或 ⌘↩）即可，不必再让助手代劳。有已暂存的内容时只提交已暂存的，否则提交当前列表里的文件；每个文件和分组都能暂存 / 取消暂存。提交钩子照常运行，被拒时显示 git 的输出并保留提交信息；提交后可以撤销（改动回到已暂存）。
  分支栏显示上游分支，可以检查远端、拉取（只快进，分叉时不合并）、推送（从不强推；没有上游时推到同名分支并设为上游）。勾上「提交后推送」对「让助手提交」同样生效。
- 3e9c99b: 右栏「改动」新增两个按钮：提交区的「✨」用辅助模型根据要提交的改动写提交信息，照着仓库最近的提交风格（请求经网关，受外发保护；开了「仅本地模型可读文件」时同样遵守）；未暂存的文件可以「放弃改动」，确认后改动存进 git stash 而不是直接丢掉，提示里可以一键撤销，已暂存的部分不受影响。
- a613d29: 右栏「改动」认得 worktree 了：同一仓库有多个 worktree（委派任务的隔离目录、agent 开的 worktree、自己 git worktree add 的）时，分支栏下面可以切换，改动、提交、拉取、推送都针对选中的那个。助手改的文件落在别的 worktree 里时会提示，一键切过去；在那边「让助手提交」时，指令里会写明 worktree 的路径。
- 863dad7: 设置 → 外观新增「我的主题」：填强调色、背景、表面、文字 4 个颜色（或一次粘贴一组）即可新建主题，其余颜色自动推导并做对比度修正，编辑时实时预览；可以浅色、深色各配一套跟随系统切换，逐个调整颜色，加背景图；支持导入、导出主题包（`.nomitheme.json`，带背景图时为 `.nomitheme`）。
- c7f967c: feat(core): Nomi conversation workspaces. `ChatOptions.extra.cwd` reaches tools as `ToolExecContext.cwd` and is validated in the core (`PermissionBroker.workspaceOf`: a directory the user chose via `knownDir`, not a filesystem root, the home folder or its ancestors, Documents / Desktop / Downloads themselves, system folders or deny-listed paths); unknown workspaces are dropped. Desktop file tools use `guardIn` / `authorizeIn` inside a workspace and fall back to the user's granted scopes with the original authorization outside it (`guardWorkspaceOrGranted`, never auto-approved), `workspace_run` (`requiresWorkspace`, hidden by `toAiSdkToolSet` without a workspace) runs commands with the CLI tabs' environment, timeout, output cap and abort, and `delegate_to_cli` inherits the workspace. `HarnessOrchestrator` gets `autoApprove` (default on, `harness.permissionDefaults({ autoApprove })`, `HarnessTabsState.autoApprove`): new tabs default to `bypass` and keep it across restarts; tabs on the old default migrate once. Nomi's chosen workspaces now enter the recent-directory list. The default working directory is `<documents>/nomi`, created on first use; a persisted main-tab cwd equal to the old default (Documents) migrates to it.
- 12a9200: 将多语言词典集中到 `@nomi-ai/i18n`，按语言、项目和模块管理稳定 key；移除中文原文 key 与旧兼容映射，并增加缺失翻译、占位符、重复基准文案与死 key 检查。

### Patch Changes

- bf74f72: fix(security): `harness.messageAgent` 标为 dangerous，且仅限对话窗口调用；补充命令审核会发送命令全文、以及没有系统沙箱时不会自动执行命令的文案。/ Mark harness.messageAgent as dangerous and chat-window-only, and add strings that command review sends the full command and that commands are not auto-run without an OS sandbox.
- 1ec2af9: feat(contract): Agent 看板的契约：新增 `fleet.state`、`fleet.archive` 与 `fleet.changed` 事件（受管与外部 agent、占用与整机负载）；补上看板与负载指示的中英文案。/ Agent board contract: adds `fleet.state`, `fleet.archive` and the `fleet.changed` event (managed and external agents, usage and machine load); zh / en copy for the board and the load indicator.
- 5a60967: fix(agent): `/agent 名字 需求` 直接派出 agent，派不出去时说明原因，不再由对话模型回一句当作已经交出。`NOMI_USE_MOCK_CLI=1` 从 `apps/desktop-go` 启动也能找到仓库里的假 CLI；假 CLI 不提供更新到正式版。新建任务的代码目录菜单不再被对话框挡住，新建任务默认改为手动运行。 / `/agent name request` starts the agent directly, and a failed handoff is explained instead of a normal reply that looks like success. `NOMI_USE_MOCK_CLI=1` finds the repo mocks when the app starts from `apps/desktop-go`. Mock CLIs are not offered an update to a real release. The code-folder menu in a new task is no longer hidden behind the dialog, and a new task defaults to run manually.
- 3cf04b1: feat(chat): 问题卡的契约事件与中英文文案（ai.userQuestion、看板「等你回答」）。/ Contract events and zh/en copy for the question card (ai.userQuestion, agent-board waiting state).
- 4d33393: fix(privacy): the IPC transport gains a `prepareChat` hook that runs in the main process before a chat request is sent, plus the messages for blocked attachments (see attachment-outbound-guard).
- 5c7fbe9: fix(ui): 恢复旧主题 id paper → cream 的映射，新增图片主题选图失败的提示文案（详见 background-image-review-fixes）。
- 632d3ed: 对话窗口可以拖入 / 粘贴任意文件，拖到对话区任意位置都能放下：图片仍作图片附件；其他文件显示为文件卡片，点开可预览内容。
  发送时 200KB 以内的文本文件连内容一起发给模型，二进制或更大的文件只发本机路径；已发送的消息里同样显示为卡片。
- cdfac34: Claude Code 的默认思考档位：initialize 响应里没有默认档位，改为读 CLAUDE_CODE_EFFORT_LEVEL 与设置里保存的 effortLevel 标在滑杆上；都没有时说明「由 Claude Code 按模型决定」，不再显示空滑杆。
- 13364fa: 修复 agent 委派的审批恢复：计划批准后的执行继续由任务系统跟踪，支持取消、后续审批、用量统计和完成回报；临时发送失败保留审批入口，计划完成后的执行确认仍可操作。关闭标签结束对应任务，过期和重复审批不会重新启动执行。
- d386961: feat(cli): context compaction for Codex and Grok tabs.

  - While the CLI compacts on its own, the tab shows "compacting context" and the context meter resets afterwards (Codex app-server `contextCompaction` items; Grok `auto_compact_*` over ACP and streaming-json).
  - `/compact` now works in Codex and Grok tabs: Nomi sends the CLI's own compaction request (Codex `thread/compact/start`, Grok `x.ai/compact_conversation`) instead of passing the text to the model, and replies "Context compacted". An empty session says there is nothing to compact; Codex in its per-turn `exec` fallback says manual compaction needs app-server; a Grok without the extension gets `/compact` as before.
  - Gemini's ACP does not report compaction, so its meter still only follows `usage_update`.

- 6448028: agent 可以同时安装 / 更新：装 Claude Code 时不再禁用 Codex 等其他助手的按钮。只有往同一位置执行的 `npm install -g` 会排队（并发会互相覆盖），排队时日志里会提示「等另一个 npm 安装完成后继续」。
- a98d631: feat(contract): 桌面设置多了受保护文件夹 `protectedPaths` 与放行的环境变量 `cliEnvAllow`，新增 `desktop.protectFolder`、`desktop.unprotectPath`、`desktop.setCliEnvAllow`；补上相应的中英文案。/ Desktop settings gain `protectedPaths` and `cliEnvAllow`, with new `desktop.protectFolder`, `desktop.unprotectPath` and `desktop.setCliEnvAllow`; matching zh / en copy.
- 996e717: feat(chat): strings for switching a tab to its default source from the model button, and a clearer third-party → official confirmation (see cli-model-button-source-switch).
- ba7efe1: feat(contract): 新增 `harness.sandboxReply`（回答沙箱授权请求：session / always / deny）、`desktop.setCliSandbox`、`desktop.removeCliSandboxAllow`；标签状态多了 `sandboxPending`，标签列表状态多了 `sandbox`（on / off / unsupported），桌面状态多了 `cliSandbox`、`cliSandboxSupported`、`cliSandboxAllow`；补上相应的中英文案。/ Adds `harness.sandboxReply` (answer a sandbox request: session / always / deny), `desktop.setCliSandbox` and `desktop.removeCliSandboxAllow`; tab state gains `sandboxPending`, the tabs state gains `sandbox` (on / off / unsupported) and the desktop state gains `cliSandbox`, `cliSandboxSupported` and `cliSandboxAllow`; matching zh / en copy.
- 9165114: feat(contract): 沙箱授权请求多了 `read`（读单个密钥文件）；沙箱「始终允许」的项可带 `project`；任务授权多了可选的 `sandbox`（预先允许的类别）；补上相应的中英文案。/ Sandbox requests gain `read` (a single secret file); "Always allow" entries can carry `project`; task grants gain an optional `sandbox` list of pre-allowed categories; matching zh / en copy.
- 6cf63e7: fix(cli): group titles for the model button when a conversation's original provider differs from the default (see cli-session-keeps-provider).
- 7ad369f: fix(cli): copy for stopping external CLI processes before removing an official account, and drop the unused "reasoning effort can't be set here" string (see cli-thirdparty-effort-login).
- 4070aab: Composer: type @ to insert a workspace-relative path (directories end with /).
- 4070aab: 运行中可以继续发消息，不会打断这一轮：Enter 把消息插入这一轮（下一个工具步骤交给 agent / Nomi），Ctrl/⌘+Enter 排队到这一轮结束再发。消息先显示在输入框上方的待发列表里，交出去之前可以撤回修改或删除；在输入框按 Esc 停止这一轮并把待发消息合成一条马上发出。插入的消息显示在回复中间。Claude Code、Codex、Grok 与 Nomi 对话支持插入，Gemini、dsh 暂时只能排队。Node 版与 Go 版一致。
- 13364fa: fix(i18n): Computer Use 的「允许」和「始终允许」文案改为：授权之后付款、发送、删除、系统设置和按坐标点击不再询问；密码管理器和银行类应用仍然拒绝。
- c0bc9ac: feat(chat): 上下文档位的契约字段与中英文文案

  网关选项增加 contextTier。模型设置里的档位说明，以及未识别模型按 256K 估算的提示，中英文都写上。

- d7938e0: 精简新会话欢迎区的中英文提示，补充模型配置入口的标题文案。
- df95d1b: refactor(core): per-instance `CoreScope` (locale, verbose logging, private root, `CliTrace`) replaces module-level state; `ContractError` is matched by name and code; `persona.systemPrompt` returns the kernel-built prompt. `personaSchema` gains an optional `pronoun`, with `personaPronoun` / `pronounForms` helpers and neutral 它 / it defaults.
- 74a9875: feat(chat): strings for deleting agent sessions (see delete-cli-sessions).
- 496f39e: feat(tts): Edge 实时朗读相关设置与提示文案（音色、语速、试听、联网/失败提示）。
- 6448028: 侧栏底部的 agent 信息卡精简为三行：端图标、名称与计费标签（订阅档位或「API 密钥」）；最吃紧的一个额度窗口；今日花费与最近活动。版本、登录方式、全部额度窗口、运行数与「新会话默认」移到点开后的详情抽屉；刷新按钮只在悬停 / 聚焦时出现。「新标签默认」改称「新会话默认」。
- c1fd479: fix(models): English/Chinese copy for the optional test-model field on the custom provider inline form (#161).
- 1ec2af9: feat(contract): 新增 `fleet.pause`、`fleet.resume`、`fleet.setAutoPause`，看板状态带上内存压力；补上内存守护的中英文案。/ Adds `fleet.pause`, `fleet.resume` and `fleet.setAutoPause`, and the board state carries memory pressure; zh / en copy for the memory guard.
- 1ec2af9: feat(contract): 看板卡片的 `paused.by` 多了 `nomi`（Nomi 暂停的），新增 `held`（内存紧张时在待进行里排队）；补上排队、派出者等中英文案。/ Board cards' `paused.by` gains `nomi` (paused by Nomi) and a new `held` flag (waiting in To do while memory is low); zh / en copy for queueing, the dispatcher and more.
- 6448028: 精简功能，让 Nomi 更专注：

  - 移除笔记（笔记库、笔记工具、知识库里的「我的笔记」来源）。
  - 移除日历同步（系统日历、本地日历、.ics 导入导出、订阅链接、CalDAV、日历工具）；设置分区改名为「日程」，提醒 / 定时任务 / 主动聊天 / 免打扰在同一页。
  - 移除截图提问（框选截图、`Ctrl/⌘+Alt+A` 全局快捷键与 `Ctrl/⌘+Shift+S`）、屏幕记忆（定时截屏与 OCR）和剪贴板历史；启动时清掉旧版本留下的屏幕记录与剪贴板历史。粘贴 / 拖入图片提问和 AI 读写剪贴板保留；快捷键设置不再有「全局快捷键」标签。
  - 提醒只走一个渠道：Nomi 在桌面时只用她的气泡；关掉 Nomi 后用灵动岛，灵动岛不可用时用系统通知，不再重复弹出。去掉了单独的「同时发送系统通知」开关。

- 843ea26: feat(ui): 图片主题所需的共享主题色、半透明 token、文案与语音面板样式（详见 global-background-image）。
- cdfac34: 修复界面卡顿：翻译每次都要重新合并整张词典（几千条），模型页展开「各档模型 / 更多」、切换下拉等操作要几百毫秒；词典改为按语言缓存，模型页展开从约 300ms 降到约 10ms。下拉菜单的说明过长时省略显示，不再出现横向滚动条；「新标签默认用」的说明精简为「不经 Nomi」。
- 0211be6: fix(i18n): 补齐 MCP 授权、会话字号与图片主题蒙版的中英文文案。/ Adds Chinese and English strings for MCP authorization, conversation text size and the image-theme mask.
- 8d9ceed: fix(i18n): renaming a conversation to `__proto__` (or `constructor`, `toString`…) no longer crashes the chat window. Translation only uses the dictionary's own string entries and returns unknown text unchanged (#142).
- cdfac34: 修复词典迁移后残留的裸 key：「助手」模式按钮、语音识别语言、屏幕记忆跳过原因、知识库索引进度、提醒星期按钮、桌面操作确认提示等处不再显示 key；诺米语音不再朗读 key；批准计划后发给 agent 的跟进消息、内置技能文件改为翻译后的正文；屏幕记忆默认排除词与默认唤醒词恢复为中文原词，重新能匹配中文窗口标题与语音。
- 83ac8f9: `IconButton` 不再写原生 title，也不再接受 `title` prop：图标按钮的可访问名只走 aria-label（docs/development/frontend-standards.md「无障碍与提示」）；清掉只用于悬停提示的中英文案 key。
- 92ab896: feat(ui): "OK" / "Please confirm" strings for the in-app confirm dialog (see in-app-confirm-dialogs).
- 3594ab1: feat(ui): strings for the in-app date / time picker (see in-app-date-time).
- 65304a3: feat(workspace): strings for the new-tab page, show/hide tabs, the Open file tab, and the in-app browser tab.
- 5da0b31: fix(i18n): 灵动岛与 agent 监视的说明改成「结束时提示一次、中途不播报」，并说明工作台在屏幕上时只弹等你处理和报警；删掉不再使用的进度汇总与卡住提醒文案。
- 0211be6: feat(contract): 新增 `ext.mcpAuthorize`（dangerous）与 `ext.mcpClearAuthorization`；MCP 状态多了 `authorization-required`，服务条目可带 `oauthClientId`、`auth`、`hasAuthorization`；流式 `reasoning` 块可带可选的 `phase: start | end`。/ Adds `ext.mcpAuthorize` (dangerous) and `ext.mcpClearAuthorization`; MCP status gains `authorization-required`, server entries can carry `oauthClientId`, `auth` and `hasAuthorization`; streamed `reasoning` chunks take an optional `phase: start | end`.
- 51a4f3f: 设置「模型」页内联添加供应商的中英文文案（先配置好供应商、从某供应商选 Nomi 对话的模型），删除旧「添加供应商」对话框与「一键填好」提示条不再使用的文案。
- cdfac34: 精简「新标签默认用」里「默认」一项的说明：「不经 Nomi，用 {CLI} 自己的登录 / 自带配置」。
- e916b9e: fix(tasks): 去掉预算拦截：任务的 `budget` 只剩 `maxRetries`，删除预算相关的文案。 / Remove budget interception: a task's `budget` only keeps `maxRetries`, and the budget strings are removed.
- ab0a3db: feat(chat): 契约与文案：确认卡片的「这个对话里不再询问」。/ Contract and copy for "Don't ask again in this conversation" on confirmation cards.
- 568c407: Nomi 对话的上下文按模型优化：每轮带多少历史改为按实际路由到的模型的上下文窗口计算（为回答预留输出空间），不再固定 8K token；用到输入预算的 95% 时，发送前自动把较早的对话压缩成摘要（同其它 CLI），对话里显示一条可展开的「已压缩」分隔线；`/compact` 可随时手动压缩。新增契约查询 `gateway.nomiContext`。Node 版与 Go 版一致。

  工具循环每轮的步数上限从 5 步放宽到 20 步，读写文件等多步任务不再中途停下。

- 9a46790: Nomi 对话的文件工具补齐增删改查：新增 `fs_edit`（按原文逐处替换，不用重写整个文件）、`fs_mkdir`、`fs_move`（移动 / 重命名）、`fs_copy`，都可撤销；`fs_write_text` 新建文件时会一并新建缺失的上级文件夹（只在已授权的范围内）；访问未授权位置失败时提示模型先请用户授权文件夹。Node 版与 Go 版一致。
- 6448028: 修复已经配了模型，欢迎屏和「开始使用」清单仍提示「添加模型」：改为按统一网关判断 Nomi 对话的模型（与主进程同一口径）。已添加模型但还没选给 Nomi 对话时，提示「选择模型」而不是「添加模型」。
- f2a3fe3: 删除新手引导「外观与启动」步骤不再使用的文案，更新欢迎介绍与语言标签。
- 6448028: 新增「职业与兴趣」引导步骤的中英文文案。
- 6448028: 新手引导 5 步新版的中英文文案（关于你、选择供应商 / 模型、还差一步、全部设好了、步骤介绍），删除声音一步、说话语气与旧模型状态等不再使用的文案。
- 9e5b580: feat(contract): `gateway.upsertProvider` 的 `keys` / `newKeys` 可带 `note`（Key 备注，最多 200 字，空串清除）；补上 Key 备注、Agent 看板关闭标签与批量关闭空闲进程、提醒合并分隔符的中英文案。/ `gateway.upsertProvider` `keys` / `newKeys` accept `note` (a key note, up to 200 characters, empty clears it); zh / en copy for key notes, closing tabs and idle processes in bulk on the Agent board, and the merged-reminder separator.
- 0b1cd1a: fix(i18n): 新增问题卡答复失败的提示文案。
- 496f39e: feat(tts): 「朗读 AI 回复」开关与统一「朗读语速」相关文案。
- d46f07e: feat(updates): add What's new / release-notes strings (show-after-update checkbox, section titles, history link) used by the post-update panel (see release-notes-after-update).
- db80457: refactor(tts): 删除内置语音模型下载相关文案，新增「诺米提示语音」与实时朗读引擎（无 / Edge / Azure / OpenAI）文案。
- ab388c2: feat(cli): drop the "External CLI" settings page and error copy (see remove-external-cli).
- 496f39e: refactor(tts): 移除 Fish / legacy 旧音色相关设置与许可文案。
- 010c6a1: feat(cli): copy for running agents without the local sign-in (no official account yet, third-party only), and drop the unused "this computer's sign-in" strings (see remove-local-sign-in).
- 6448028: 工作台去掉顶部的对话标签条与「精简 / 全量」界面模式（设置和新手引导里的这一项一并移除）：会话统一在侧栏切换（当前会话在侧栏高亮），对话区顶部不再显示会话标题，只留工作目录与改动栏按钮。侧栏里正在运行 / 排队的会话在时间位置显示「进行中」/「排队中」，Nomi 主对话回复时也算进行中。快捷键保留：`Ctrl+Tab` / `Ctrl+Shift+Tab` 切换会话、`Ctrl/⌘+T` 按当前端和目录新开、`Ctrl/⌘+Shift+W` 关闭、`Ctrl/⌘+Shift+R` 在侧栏里重命名当前会话。
- 3197adc: feat(contract): 增加对话窗口专用的文件预览、目录、修订保存与外部资源契约，补齐预览与图片操作的主题令牌和中英词条。
- 6841bef: Chat usage chunks and agent messages can include `responseModel`: the model name an upstream provider returned when it is not the model that was requested. The turn footer explains that name in both languages.
- 1a30b01: feat(updates): add the "Restart to update" string used by the new update entry points (see restart-update-entry-points).
- 1ec2af9: fix(i18n): 沙箱授权类别的说明写清各自包含什么。/ Sandbox grant category descriptions say what each one covers.
- 145cb39: fix(chat): Nomi 发送前还在准备（压缩上下文、召回记忆等）时切到另一个会话，这一轮的请求不再带上那个会话的 id 和工作区：会话与工作区在发起时就固定，随请求显式带给内核；准备期间原会话被删除则不发送，也不会把消息显示到新会话里（#184）。
- 1ec2af9: feat(i18n): 会话详情栏的中英文案。/ zh / en copy for the session details column.
- 1ec2af9: feat(i18n): 会话详情「任务」列表与展开按钮的中英文案。/ zh / en copy for the session details task list and the show-more button.
- d7938e0: 移除设置目录品牌头后不再使用的中英文副标题词条。
- 6448028: 设置从 13 个分区精简为 7 个：通用（含快捷键、语音、截图提问、通知 / 灵动岛标签）、模型与供应商（含本机模型）、agents、用量与质量（用量与费用 + 对比 / 趋势 / 请求明细）、知识与记忆（含日程）、扩展 · MCP、隐私与权限（含数据导出）。去掉「知识 · 记忆 · 日程」抽屉和单独的截图提问、本机管理弹窗：侧栏图标、快捷键与命令面板都直接打开设置里对应的标签。
- 53a474c: feat(chat): 新增弹出的侧边聊天在窗口之间交接内容用的契约（`chatWindow.handoffPut` / `chatWindow.handoffTake`，只在内存里），以及「新侧边聊天」「侧边聊天 N」的文案。/ Add the contract for handing a popped-out side chat's content between windows (`chatWindow.handoffPut` / `chatWindow.handoffTake`, memory only), plus the "New side chat" and "Side chat N" strings.
- b7cf717: feat(i18n): 新增选中文字工具条（添加到对话 / 在侧边聊天中提问）和侧边聊天的文案。/ Add strings for the text-selection toolbar (add to chat / ask in side chat) and the side chat.
- 85b017c: feat(chat): 新增标签弹出窗口的契约（`chatWindow.detachTab` / `detachedTabs` / `dockTab`，事件 `chatWindow.detachedChanged` / `chatWindow.tabDocked`），以及标签排序、向右拆分、在新窗口打开、放回主窗口和子任务悬停卡片的文案。/ Add the contract for popping side tabs out into their own window (`chatWindow.detachTab` / `detachedTabs` / `dockTab`, events `chatWindow.detachedChanged` / `chatWindow.tabDocked`), plus strings for tab reordering, split right, open in new window, move back to main window and the sub-task hover card.
- 342aaa9: feat(i18n): 新增对话旁标签区的文案（主会话标签、关闭、铺满 / 回到分栏、打开菜单）。/ Add strings for the tab area beside the chat (main-chat tab, close, maximize / restore, open menu).
- 6448028: 新用户引导：侧栏在还没有对话时显示「开始使用」清单——添加模型、安装 agent（Claude Code / Codex 一键安装）、开始第一个对话，每一步按真实状态打勾；能用之后再推荐截图提问、知识库文件夹、导入 MCP 与技能。有了对话或点「×」后不再出现。助手模式还没配模型时，欢迎屏的快捷问题换成「添加模型」按钮，不会一点就报错。
- d7938e0: 增加导航状态色令牌，补充 DeepSeek Harness 完整名称，并更新侧栏显示设置说明。
- c6d6b2c: fix(sidebar): 「其他对话」与「新建会话失败」的文案。 / Strings for "Other chats" and "Couldn't create the conversation".
- 429d2b1: fix(sidebar): 「展开显示」改为「再显示 N 条」。 / "Show more" becomes "Show N more".
- 79641ea: feat(chat): "No matching model" for `/model` completion; drops the hint about entering a full model id (see slash-model-popover, cli-model-no-custom-id).
- d7938e0: feat(i18n): 补充开屏动画的启动状态与跳过按钮中英文文案。
- 4e2760c: `tasks.trace` 读出后台 Nomi 最近一次执行的工具步骤，供子任务侧栏使用。补上进程内子代理和后台 Nomi 在侧栏里的说明文案，并去掉不再使用的子任务输入框占位。 / `tasks.trace` returns the latest background-Nomi attempt's tool steps for the sub-task side panel. Add the side-panel notes for in-process subagents and background Nomi, and drop the unused sub-task composer placeholder.
- 18b4428: feat(contract): 新增 `harness.messageAgent`（在子任务侧栏里直接对 CLI 子代理说话，结果带 `via` / `reason` / 关联标签 `tabId`）；`tasks.followUp` 接受 `images`（最多 8 张，可以只带图片）；补上直接对子代理说话的中英文案，删掉「后台 Nomi 追问只能发文字」。/ Add `harness.messageAgent` (message a CLI subagent directly from the side panel; the result carries `via` / `reason` / the linked `tabId`); `tasks.followUp` accepts `images` (up to 8, images alone are fine); zh / en copy for direct subagent messages, and drop the "text-only follow-ups" notice.
- f053e05: feat(contract): `tasks.trace` 列出每次执行（`attempts`，追问的原话在 `note`）和正在跑的那次写到一半的快照（`live`）；新增 `tasks.steer`（运行中插话）、`tasks.followUp`（结束后追问）和 `tasks.live` 事件（正文增量、工具步骤、插话）；补上侧栏追问与实时更新的中英文案。/ `tasks.trace` lists every attempt (`attempts`, with the follow-up text in `note`) plus a snapshot of the running one (`live`); add `tasks.steer` (interject while running), `tasks.followUp` (follow up after it ends) and the `tasks.live` event (text deltas, tool steps, interjections); zh / en copy for side-panel follow-ups and live updates.
- 88bcadc: feat(contract): `delegate.completed` 的结果可带 `followUp`（委派结束后在子任务里接着跑的一轮）；补上子任务面板的中英文案。/ `delegate.completed` results can carry `followUp` (a later turn in the sub-task after the delegation finished); zh / en copy for the sub-task pane.
- 332abab: 右栏「生成提交信息」在 Nomi 自己还没选模型时，改用当前 agent 标签的第三方模型；两边都没有可用模型时明确提示去「设置 → 模型」选一个。
- 11d32fa: feat(chat): Chinese and English copy for the per-model thinking-depth slider (see thinking-depth).
- 9fdb8d3: feat(mascot): 删除 83 条已下线的诺米台词文案（中英文）。
- 2d5f553: fix(updates): add the "new version is still being published" message (see update-release-pending).
- 2b714ef: agents（Claude Code / Codex / Grok）没有登录或登录已失效时，额度卡片不再显示红色的「没有登录或登录已失效，已清除旧额度」报错。
- 4070aab: 工作台新增「执行轨迹」开发者工具：助手消息操作栏打开右侧抽屉，查看这一轮的时间线与耗时、工具调用的参数与输出、经过网关的模型请求（可看请求与响应正文）和 agent 子进程的原始收发，方便排查工具调用和任务执行问题。agent 标签与 Nomi 对话都支持，Node 版与 Go 版一致。
- fb84243: fix(security): `workspace_run` confirms with `force: { dialog: true }`, so auto-approve and remembered approvals no longer skip it and plan mode blocks it; the confirm preview cap goes from 4000 to 16000 characters so the full command is shown. The tool description, the workspace system hint and the auto-approve setting copy now state that commands aren't confined to the workspace (see workspace-run-always-confirm).
- d7938e0: 补充内容区背景、阴影及分隔线主题令牌，更新单按钮显示设置说明。
- cdfac34: 修复 agent 切换工作目录后仍显示旧会话上下文的问题：新目录会清空可见转录，选择带上前文时只把前文一次性传给新会话，并将待带入提示移到对话区顶部。修复从侧栏新建 Nomi 会话时异步创建未完成就改写旧条目的问题，旧会话会保留并新增一条会话记录。CLI 会话镜像现在按原生会话 ID 与本机历史去重，并同步最新标签标题。
