---
'@nomi-ai/ai-chat': patch
'@nomi-ai/cli-catalog': patch
'@nomi-ai/desktop-go': patch
---

「自动」档严格按「由 CLI 自行判断哪些操作需要确认」下发，并且在 Claude 上只在真正办不到的时候才换档。

- **Claude**：`auto` 就是「Claude 自己判断」，原样下发 `--permission-mode auto`。它的判断由**服务端**分类器负责（beta `auto-mode-classifier-2026-07-16`，走同一个 base URL 的附带请求），因此第三方端点只要能提供 Claude 模型并透传该 beta，auto 一样可用。只有两种情况真的跑不起来：主模型不是 Claude（如 `amux/deepseek-v4.1-flash`、`amux/gpt-6.1-terra`，分类请求会被路由到那个非 Claude 模型），或者端点把这项检查挡掉了。此时 Nomi 用 `-p` 长驻进程（`attended=false`），Claude 连「退而询问用户」都不做，只会把每个要检查的动作一律硬拒（`auto_mode_no_check_in_session`，实测一轮空转 16 分钟后 `error_during_execution`）。所以：Claude 家族模型跑 `auto` 不变，非 Claude 模型在第三方端点上降为 `acceptEdits`（仍是 Claude 自己按规则判断，其余动作走 Nomi 的审批卡），不是 `bypassPermissions`。实际下发的档位记在 `permissionModeCli`，回报时不会把用户的「自动」顶成别的档位。
- **Grok**：`auto` 原来降到 `default`（逐项确认，等于把「自动」变成了「每次都问」），改为 `acceptEdits`；同时补上 `auto` 档。
- **Codex**（`on-request` + `auto_review`）、**Kimi**（`yolo`）、**Gemini**（`autoEdit`）、**MiniMax**（`plan` / `manual`）保持各自的原生判断档。
- **委派**：Nomi 处于「自动」时，后台子 agent 用 `bypass` —— 那里无人值守，任何「问一下」都会让任务半路死掉；不支持 bypass 的 CLI 退回它能给的最高档。
- 权限被拒与会话提示不再被丢掉：解析 Claude 的 `system/informational`（`auto_mode_no_server_check`）与 `system/permission_denied`，运行中状态行会说明「校验不了动作」，这一轮结束时也给一句人话（点名被拒的工具、提示换权限模式或换回 Claude 模型），而不是光秃秃的 `error_during_execution`。

Auto mode now means "the CLI decides which actions need confirmation".

- **Claude**: `auto` is passed through as-is — its server-side classifier (beta `auto-mode-classifier-2026-07-16`, a side request over the same base URL) works over third-party endpoints too, as long as they serve a Claude model and pass the beta through. It genuinely cannot run when the main model isn't Claude (`amux/deepseek-v4.1-flash`, `amux/gpt-6.1-terra`) or when the endpoint blocks the check; Nomi's `-p` session is non-interactive (`attended=false`), so Claude won't fall back to asking and instead refuses every checked action. In that case `auto` degrades to `acceptEdits` — still Claude's own rules, with other actions going through Nomi's approval card — never `bypassPermissions`. The effective tier is tracked so a reported mode never overrides the user's choice.
- **Grok**: `auto` used to fall back to `default` (ask every time); it now maps to `acceptEdits`.
- **Codex** (`on-request` + `auto_review`), **Kimi** (`yolo`), **Gemini** (`autoEdit`) and **MiniMax** (`plan` / `manual`) keep their native judgement tiers.
- **Delegation** under auto runs with `bypass`, because nobody is there to answer a prompt.
- Permission denials and informational notices are parsed: the status line says actions are being refused, and the turn ends with an explanation naming the blocked tools instead of a bare `error_during_execution`.
