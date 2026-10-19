# 编程助手权限模式（设计稿 + 实现记录）

> 状态：**PR 1（主进程）、PR 2（界面）已实现**；PR 3（计划审批流）待做。
> 查证日期 2026-10-19：Claude Code 2.1.303、Codex CLI 0.163.0、dsh 0.2.0-rc.2、Grok Build 1.0.62（macOS）。
> 代码：`packages/electron/src/cli/permissionMode.ts`、`CliHarnessService.ts`。

## 1. 背景：为什么要做

Nomi 把消息转发给本机 CLI 时，四个后端的权限原本各自为政：

| 后端        | 原来的启动方式                              | 实际效果                                                                               | 问题                     |
| ----------- | ------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------ |
| Claude Code | 常驻进程 + `--permission-prompt-tool stdio` | 每一步弹卡片确认                                                                       | 只有这一种模式           |
| Codex       | `exec --json`，不带沙箱参数                 | **`exec` 默认 `read-only` 沙箱 + 禁网**：模型能读不能写，会告诉用户「只有读的权限」    | 用户无法完成任何改动     |
| dsh         | `--profile headless --json`                 | 沙箱 `workspace-write`、审批 `ask`；无头模式没有审批界面，需要审批的操作**直接被拒绝** | 越界操作被静默拦截       |
| Grok        | 写死 `--yolo`                               | 全部放开                                                                               | 默认最高权限，有安全隐患 |

切换工作目录本身不涉及权限：换目录即开新 CLI 会话，可写根随 spawn 的 cwd 走。

## 2. 统一五档与映射

每个标签一个 `permissionMode`（`HarnessTabMeta.permissionMode`），启动 / 切换时按下表映射到各 CLI 原生参数：

| Nomi 模式          | 值            | Claude Code                           | Codex（全部经 `-c`）                                                             | dsh（环境变量）                          | Grok                            |
| ------------------ | ------------- | ------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------- |
| 计划               | `plan`        | `--permission-mode plan`              | `sandbox_mode="read-only"` + 计划提示前缀                                        | `DSH_PERMISSION_MODE=read-only` + 前缀   | `--permission-mode plan` ⚠️     |
| 逐项确认           | `manual`      | `--permission-mode default`（弹卡片） | 不支持 → 降为计划                                                                | 不支持 → 降为计划                        | 暂不开放 → 降为计划 ⚠️          |
| 自动改文件（默认） | `acceptEdits` | `--permission-mode acceptEdits`       | `sandbox_mode="workspace-write"` + `sandbox_workspace_write.network_access=true` | `DSH_PERMISSION_MODE=workspace-write`    | `--permission-mode acceptEdits` |
| 自动               | `auto`        | `--permission-mode auto`              | 上一行 + `approval_policy="on-request"` + `approvals_reviewer="auto_review"`     | 不支持 → 降为自动改文件                  | `--permission-mode auto` ⚠️     |
| 完全放开           | `bypass`      | `--permission-mode bypassPermissions` | `sandbox_mode="danger-full-access"`                                              | `DSH_PERMISSION_MODE=danger-full-access` | `--yolo`                        |

⚠️ = 未在真机验证（本机 Grok 未登录）。

降级规则（`effectiveMode`）只往更安全的一侧：`manual → plan`，`auto → acceptEdits`。

### 2.1 查证细节

- **Codex**
  - `codex exec` 不带 `-s` 时沙箱为 `read-only`；`workspace-write` 默认禁网，需 `sandbox_workspace_write.network_access=true`（实测 `curl https://example.com` → 200）。
  - `exec resume` **不接受** `--sandbox` / `--cd` / `--approve-for-me`，所以全部用 `-c` 传，新建与续接共用一套。
  - 「自动」：`approvals_reviewer` 取值 `user | auto_review | guardian_subagent`（由错误提示得出）。对照实测：只开 `workspace-write` 时写工作区外文件 → 被拦；加 `approval_policy="on-request"` + `approvals_reviewer="auto_review"` → 自动审批通过并写入。
  - `-c` 优先级高于 `~/.codex/config.toml`：用户在配置里写的 `sandbox_mode` 会被标签模式覆盖。
- **dsh**（读 `--dump-config` 与插件源码）
  - 权限只由 `DSH_PERMISSION_MODE` 决定（`read-only` / `workspace-write` / `danger-full-access`）；只有 `danger-full-access` 时审批策略为 `never`，其余为 `ask`。
  - 无头模式没有 answerer：`ask` 的请求 fail closed（直接拒绝），因此不提供「逐项确认」「自动」。
  - 可写根 = 进程 cwd（`workspaceRoot: process.cwd()`），Nomi spawn 时 cwd 即标签目录。
  - macOS 沙箱为 Seatbelt `(allow default)(deny file-write*)` + 可写根，**不限制网络**，无需联网开关。
  - 计划模式由 `dsh-plan-mode` 插件（`/plan` 命令、`exit_plan_mode` 工具）提供，但无头模式没有入口参数；`exit_plan_mode` 在无头下也会因无人审批被拒。暂用只读沙箱 + 计划提示前缀。
- **Claude Code**
  - 长驻 stream-json 进程支持运行中切换：stdin 写 `{"type":"control_request","request_id":…,"request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}` → 返回 `control_response success`，随后 `system/status` 事件带 `permissionMode`。**无需重启进程。**
  - `--permission-mode` 可选值里 `manual` 与 `default` 都接受（`manual` 会被归一为 `default`），用 `default` 兼容旧版本。
- **Grok**：`--yolo`、`--no-auto-update` 不在 `--help` 里，但实测可用；`--permission-mode` 可选 `default | acceptEdits | auto | dontAsk | bypassPermissions | plan`。无头模式下 `default` 的权限事件格式未知，所以暂不开放「逐项确认」。

## 3. 主进程（PR 1，已实现）

- **类型**：`HarnessPermissionMode = 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'bypass'`；`HarnessTabMeta.permissionMode`；`HarnessTabsState` 增加 `defaultPermissionMode`、`codexNetwork`。
- **映射模块** `cli/permissionMode.ts`（纯函数）：`supportedModes` / `effectiveMode` / `permissionLaunch` / `claudeModeName` / `planPromptPrefix`。
- **生效时机**
  - Claude：`setTabPermissionMode` 对长驻进程写 `set_permission_mode`；stdin 不可写时拆进程，下一轮带新 `--permission-mode` 与 `--resume` 重拉。`ensureClaudeLive` 发现进程模式与标签不一致也会重拉。
  - Codex / dsh / Grok：每轮一个进程，下一轮生效。
  - 计划提示前缀只加在发给 CLI 的提示上，不改落盘的用户消息。
- **IPC**（经 `ai:*` 发送方校验）
  - `ai:harness:tab-permission-mode(tabId, mode, { confirmed })` → 返回 `HarnessTabMeta & { degraded }`。
  - `ai:harness:permission-defaults({ defaultPermissionMode?, codexNetwork? })` → 返回 `HarnessTabsState`。
  - `ai:harness:tab-create` 接受 `permissionMode`（分叉继承用）。
- **安全约束**
  - `bypass` 必须带 `confirmed: true`，否则抛错（防止渲染层绕过确认框）。
  - `bypass` 不能设为默认、不能经 `tab-create` 继承、**不跨重启保留**（重启后回到默认档）。
- **迁移**：旧数据没有 `permissionMode` 时，Claude 标签还原为 `manual`（保持原来的逐项确认），其它后端用默认档 `acceptEdits`。行为变化只有 Grok：从全部放开降到「自动改文件」（见 changeset）。
- **持久化**：主标签档位存 `session.json`；其它标签与默认档 / 联网开关存 `tabs.json`。

## 4. 界面（PR 2，已实现）

实现：`ai-chat/src/components/PermissionModeChip`、`utils/permissionModes.ts`、`/mode` 命令（`slash/adapters/common.ts`）。
与下面原计划的差异：

- 「新标签默认模式」放在模式下拉底部（「设为新标签默认」），没有单独的设置页；「Codex 允许联网」保持默认开，暂无界面开关。
- 另加了 `/mode plan|manual|edits|auto` 命令；`/mode bypass` 会被拒绝，只能从芯片进入并确认。
- `degraded` 的提示显示在芯片旁（5 秒后消失），StatusLine 暂未显示模式。

原计划：

- 输入框底部、后端切换器旁放模式 chip（图标 + 文字），点开下拉；当前后端不支持的档位置灰并说明原因。
- 输入框聚焦时 `Shift+Tab` 在支持的档位间循环，**跳过「完全放开」**。
- 「完全放开」只能从下拉进入，先弹确认框；之后标签、状态栏、chip 用 `var(--cd-danger)` 标红。
- 设置 → 编程助手：「新标签默认模式」（默认自动改文件）、「Codex 允许联网」（默认开）。
- `StatusLine` 显示当前模式；`degraded` 时提示（如「dsh 不支持逐项确认，已使用计划模式」）。
- 分叉 / 跨后端切换：渲染层把来源标签的 `permissionMode` 传给 `tab-create`（`forkConversation.ts`）。
- 无障碍：`aria-label="权限模式：自动改文件"`，`Esc` 关闭并把焦点还给输入框；文案同步 `en.json`。

## 5. 计划模式审批流（PR 3，待做）

| 后端   | 方案如何交回                                  | Nomi 处理                                                                                                  |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Claude | `ExitPlanMode` 工具 → `can_use_tool` 权限请求 | 渲染为「批准计划」卡片：批准并自动改文件 / 批准并逐项确认 / 继续修改；批准 = allow + `set_permission_mode` |
| Codex  | 只读沙箱下输出文字方案                        | 回合结束后显示「按此方案执行」：切到自动改文件并发送「按上述计划实施」                                     |
| dsh    | 同 Codex（`exit_plan_mode` 在无头下会被拒）   | 同 Codex                                                                                                   |
| Grok   | 未知 ⚠️                                       | 先按 Codex 处理，确认事件格式后再改                                                                        |

另外：Claude 批准 `ExitPlanMode` 后自身会切换模式，应解析 `system/status.permissionMode` 回写标签，避免 Nomi 与 CLI 档位不一致。

## 6. 测试

- `tests/unit/cli/permissionMode.test.ts`：四个后端 × 五档的映射与降级（表驱动）。
- `tests/unit/cli/CliHarness.mock.test.ts`「permission modes」：默认档与降级、`bypass` 需确认且不能设默认、旧数据迁移与 `bypass` 不跨重启、Claude 运行中切换不重启（mock-claude 支持 `NOMI_MOCK_CLAUDE_CONTROL_LOG`）、Codex 各档参数（含续接）、dsh 的 `DSH_PERMISSION_MODE`、Grok 不再默认 `--yolo`。
- 真机冒烟（待 PR 2 后补齐）：每个后端每档跑一次「写一个文件 + curl 一个网址」。

## 7. 待真机确认

1. dsh 配上 API Key 后：越界写的拒绝事件格式（用于提示「被沙箱拦截」）；`/plan` 作为任务文本是否按命令执行；`DSH_PERMISSION_MODE` 在 `--session-id` 续接时是否生效。
2. Grok 登录后：`default` / `plan` / `auto` 在无头模式下的权限与计划事件；确认后再开放「逐项确认」。

## 8. 后续可开放的能力

- 额外可写目录：Codex `sandbox_workspace_write.writable_roots=[…]`、Claude `--add-dir`。
- 按标签选模型 / 推理强度：Codex `-c model=…`、`model_reasoning_effort`；Claude / Grok `--model`。
- 工具白名单 / 黑名单：Claude 与 Grok 的 `--allowedTools` / `--disallowedTools`。
