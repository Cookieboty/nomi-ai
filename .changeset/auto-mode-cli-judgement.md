---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(cli): 「自动」档在 Nomi 里跑不起来，不是端点不支持，是 Nomi 把 auto 的前置状态过滤掉了。

- **根因**：Claude 的 auto 判定不是单独一次附带请求，而是随每次 `/v1/messages` 带上 `safeguards` + beta `dangerous-tool-use-*`，结果回到响应的 `safeguard_results`。第三方网关原样转运就能用（Nomi 自己的网关一直这么转，网关 trace 里可查）。真正缺的是 CLI 侧的两份状态：`.claude.json` 里那组 auto opt-in 标记，以及走第三方端点时那条 24 小时有效的「分类器会计费」确认。Nomi 给每个标签单独建配置目录、`.claude.json` 只按白名单拷 8 个键，auto 的状态一个都没有 —— CLI 于是判定「这个 session 跑不了安全检查」（`auto_mode_no_check_in_session`），而 `-p` 长驻进程没有人可以问，每个需要检查的动作都被硬拒。
- **修复**：`accounts.EnsureAccountHome` 的继承白名单补上 auto 的 opt-in 标记（`hasSeenAutoModeEntryWarning`、`hasSeenAutoDefaultNotice`、`hasSeenAutoModeOutsideReadPrompt`、`hasResetAutoModeOptInForDefaultOffer`、`autoModeEnvSetup`、`autoModeClassifierBillingNoticeAcknowledgedAt`）；那条计费确认在每次启动时续期，且只在用户配过 `autoMode` 时才写，不替没开自动档的人凭空造一份同意。
- **文案**不再断言「这个端点不支持」，改成「这次的检查没跑起来」，也不再拿模型名解释；顺手修掉状态行里的错别字「被拒绕」。
- **保留实测兜底**：只有当 Claude 自己报出 `auto_mode_no_server_check` / `auto_mode_no_check_in_session` 时，才把「端点 + 模型」记进 `auto-mode-support.json`、下次改用 `acceptEdits`；换了供应商或模型会自动重新试。
- 顺带：`auto` 永远原样下发，不按模型名或供应商猜；Grok 的「自动」映射到 `acceptEdits`（原来掉回逐项确认），Codex 用 `on-request` + `auto_review`，Kimi 用 `yolo`，Gemini 用 `autoEdit`。委派出去的子 agent 在「自动」档下用 `bypass` —— 那里无人值守，任何「问一下」都会让任务半路死掉。

Auto mode in Nomi was blocked by Nomi itself, not by the endpoint.

- **Root cause**: Claude's auto-mode judgement isn't a separate side request; every `/v1/messages` carries `safeguards` plus the `dangerous-tool-use-*` beta, and the verdict comes back in `safeguard_results`. Any gateway that passes the request through works — Nomi's own gateway has always done so (see the gateway traces). What was missing were two pieces of CLI state: the auto opt-in flags in `.claude.json`, and the 24-hour "classifier is billed" acknowledgement required for third-party endpoints. Nomi gives every tab its own config directory and copied only eight whitelisted keys into `.claude.json`, so none of that state existed — the CLI concluded its safety check does not run in this session (`auto_mode_no_check_in_session`), and a `-p` session has nobody to ask, so every action needing the check was refused.
- **Fix**: the inheritance whitelist in `accounts.EnsureAccountHome` now carries the auto opt-in flags, and the billing acknowledgement is renewed on every launch — only for users who actually configured `autoMode`, never fabricated for anyone else.
- Wording no longer claims "this endpoint doesn't support it"; it says the check didn't run this time.
- The measured fallback stays: only when Claude itself reports `auto_mode_no_server_check` / `auto_mode_no_check_in_session` is that endpoint+model recorded in `auto-mode-support.json` so the next launch uses `acceptEdits`; switching provider or model retries auto.
