# @nomi-ai/cli-catalog

## 0.1.1

### Patch Changes

- 2958f64: fix(cli): 清单给 Grok 补上「自动」档，映射到 CLI 的 acceptEdits；此前没有这一档，选「自动」会掉回逐项确认。

  The manifest now gives Grok an `auto` tier mapped to the CLI's acceptEdits; without it, picking "auto" fell back to asking every time.

## 0.1.0

### Minor Changes

- 4070aab: 运行中可以继续发消息，不会打断这一轮：Enter 把消息插入这一轮（下一个工具步骤交给 agent / Nomi），Ctrl/⌘+Enter 排队到这一轮结束再发。消息先显示在输入框上方的待发列表里，交出去之前可以撤回修改或删除；在输入框按 Esc 停止这一轮并把待发消息合成一条马上发出。插入的消息显示在回复中间。Claude Code、Codex、Grok 与 Nomi 对话支持插入，Gemini、dsh 暂时只能排队。Node 版与 Go 版一致。
- 0cede0d: 移除 Gemini 的官方账号：Google 已不再让 Gemini CLI 用个人 Google 账号登录（Code Assist for individuals）。Gemini 不再提供 Google 账号登录、多账号和切换账号，来源只剩「Gemini 自己的配置」（终端里 `~/.gemini` 配的 API Key、Vertex AI 或企业版授权）和第三方供应商；旧版本保存的 Gemini 账号与 Nomi 账号目录里的登录凭据在升级时删除，终端里的 `~/.gemini` 不动。Gemini 没有可用认证时，提示改配 API Key 或选第三方模型。

### Patch Changes

- ab388c2: docs(cli-catalog): drop the external CLI mention from the interject capability note (see remove-external-cli).
- d7938e0: 增加导航状态色令牌，补充 DeepSeek Harness 完整名称，并更新侧栏显示设置说明。
