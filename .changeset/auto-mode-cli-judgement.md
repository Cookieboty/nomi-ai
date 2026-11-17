---
'@nomi-ai/ai-chat': patch
'@nomi-ai/cli-catalog': patch
'@nomi-ai/desktop-go': patch
---

fix(cli): 「自动」档严格按「由 CLI 自行判断哪些操作需要确认」下发；要不要降级只看实测，不看模型叫什么。

- **Claude**：`auto` 就是「Claude 自己判断」，**原样下发** `--permission-mode auto`，你选了什么模型、换了哪个供应商都照用。它的判断由服务端分类器负责（beta `auto-mode-classifier-*`，走同一个 base URL 的附带请求），能不能跑取决于对端是否透传这项检查——**与模型名无关**，所以不再按名字猜。只有当 Claude 自己报出 `auto_mode_no_server_check` / `auto_mode_no_check_in_session`（说明这个端点确实没透传，而 Nomi 的 `-p` 长驻会话又是非交互的，Claude 不会退而询问、只会硬拒每个待检查动作）时，才把这个「端点 + 模型」组合记进 `auto-mode-support.json`，下次启动自动改用 `acceptEdits`（Claude 自己按规则判断、改文件自动过，其余动作走 Nomi 审批卡），并提示你原因；换回支持的服务商后自动恢复。降级目标是 `acceptEdits`，不是 `bypassPermissions`。
- **Grok**：`auto` 原来降到 `default`（逐项确认，等于把「自动」变成了「每次都问」），改为 `acceptEdits`；同时补上 `auto` 档。
- **Codex**（`on-request` + `auto_review`）、**Kimi**（`yolo`）、**Gemini**（`autoEdit`）、**MiniMax**（`plan` / `manual`）保持各自的原生判断档。
- **委派**：Nomi 处于「自动」时，后台子 agent 用 `bypass` —— 那里无人值守，任何「问一下」都会让任务半路死掉；不支持 bypass 的 CLI 退回它能给的最高档。
- 权限被拒与会话提示不再被丢掉：解析 Claude 的 `system/informational` 与 `system/permission_denied`，运行中状态行会说明「校验不了动作」，这一轮结束时也给一句人话（点名被拒的工具），不再是光秃秃的 `error_during_execution`。

Auto mode means "the CLI decides which actions need confirmation", and downgrades are based on measurement, not model names.

- **Claude**: `auto` is passed through as-is for whatever model or provider you pick. Its server-side classifier works whenever the endpoint passes the check through — a question of endpoint capability, not model naming. Only when Claude itself reports `auto_mode_no_server_check` / `auto_mode_no_check_in_session` (the endpoint really doesn't pass it through, and Nomi's `-p` session is non-interactive so Claude refuses instead of asking) is that endpoint+model combination recorded in `auto-mode-support.json`, so the next launch uses `acceptEdits` with an explanation; it reverts automatically for providers that support it. Never `bypassPermissions`.
- **Grok**: `auto` used to fall back to `default` (ask every time); it now maps to `acceptEdits`.
- **Codex** (`on-request` + `auto_review`), **Kimi** (`yolo`), **Gemini** (`autoEdit`) and **MiniMax** (`plan` / `manual`) keep their native judgement tiers.
- **Delegation** under auto runs with `bypass`, because nobody is there to answer a prompt.
- Permission denials and informational notices are parsed: the status line says actions are being refused, and the turn ends with an explanation naming the blocked tools.
