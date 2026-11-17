---
'@nomi-ai/ai-chat': patch
'@nomi-ai/cli-catalog': patch
'@nomi-ai/desktop-go': patch
---

「自动」档严格按「由 CLI 自行判断哪些操作需要确认」下发，不再被误降成逐项确认、只读或完全放开。

- **Claude**：`auto` 直传 `--permission-mode auto` —— 这就是「CLI 自己判断」的那一档。但它的判断跑在**服务端**，请求走第三方网关（Nomi 本地端口、Amux 等）时分类器不可达，Claude 会把每个要检查的动作一律拒绝（`auto_mode_no_check_in_session`），而且不会回头问 host：一轮空转十几分钟、烧掉二十多美元后以 `error_during_execution` 收场。现在只在官方直连时下发 `auto`，其余端点降级为 `acceptEdits`（仍是 Claude 自己按规则判断，不是 `bypassPermissions`）。实际下发的档位记在 `permissionModeCli`，回报时不会把用户的「自动」顶成别的档位。
- **Grok**：`auto` 原来降到 `default`（逐项确认，等于把「自动」变成了「每次都问」），改为 `acceptEdits`。
- **Kimi**：`auto` → `yolo`（日常改动与命令自动、危险操作仍询问）—— 保留，这正是「CLI 自行判断」。
- **Codex**：`approval_policy="on-request"` + `approvals_reviewer="auto_review"` 保留，由 Codex 自己审查。
- **Gemini**：`auto` → `autoEdit` 保留。
- **MiniMax**：没有自动档，仍是 `plan` / `manual`。
- **委派**：Nomi 处于「自动」时，后台子 agent 用 `bypass` —— 那里没人值守，任何「问一下」都会让任务半路死掉；不支持 bypass 的 CLI 退回它能给的最高档。
- 权限被拒与会话提示不再被丢掉：解析 Claude 的 `system/informational`（`auto_mode_no_server_check`）与 `system/permission_denied`，运行中状态行会说明「校验不了动作」，这一轮结束时也给一句人话（点名被拒的工具、让用户换权限模式），而不是光秃秃的 `error_during_execution`。

Auto mode now means what it says: the CLI decides which actions need confirmation.

- **Claude**: `auto` is the right tier, but its classifier runs server-side and is unreachable through a local gateway or third-party relay, so every checked action was refused and the host was never asked. It is now sent only on official connections; other endpoints fall back to `acceptEdits` — still Claude's own judgement, not `bypassPermissions`. The effective tier is tracked so a reported mode never overrides the user's choice.
- **Grok**: `auto` fell back to `default` (ask every time); it now maps to `acceptEdits`.
- **Kimi** keeps `yolo` (routine work automatic, dangerous actions still asked), **Codex** keeps `on-request` + `auto_review`, **Gemini** keeps `autoEdit`, **MiniMax** stays `plan` / `manual`.
- **Delegation** under auto runs with `bypass`, because nobody is there to answer a prompt.
- Permission denials and informational notices are parsed: the status line says actions are being refused, and the turn ends with an explanation naming the blocked tools instead of a bare `error_during_execution`.
