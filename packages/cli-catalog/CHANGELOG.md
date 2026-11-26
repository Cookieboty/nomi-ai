# @nomi-ai/cli-catalog

## 0.1.4

### Patch Changes

- 386d751: fix(antigravity): 将 Antigravity 收口为纯人工交互薄客户端并打磨官方 ACP 协议实现

## 0.1.3

### Patch Changes

- 780cb0e: fix(model-switch): 模型胶囊按底座清单的品牌去重图标，不重复画同一个模型品牌的图标

  - `@nomi-ai/ui` 新增 `modelBrandIsNative`：只比较模型认出的品牌 id 与底座自家模型的品牌 id，不做底座 → 品牌的表单
  - `@nomi-ai/cli-catalog` 清单新增 `branding.modelBrand`（纯展示元数据，界面信息 `BUILTIN_RENDERER` 里透传为 `brand`），7 个自带官方模型的底座在清单里各写一次；Antigravity 未声明自家模型品牌，因此不写，也不做这项去重
  - 模型胶囊的自家品牌改从清单读，删掉原来写在模型切换组件里的底座 → 品牌对应表：底座自己的模型（Claude Code、Codex、Grok、Gemini、dsh、Kimi Code、MiniMax Code）只留底座图标，别家的模型、认不出厂商的模型、没有自家品牌的底座（含 Antigravity）照常画图标
  - 回归测试直接读各清单的真实 `branding.modelBrand` 与模型 id 跑判定，不重写一张品牌表

## 0.1.2

### Patch Changes

- b00c72c: 把应用内本机官方登录管理做成清单能力位，仅 Antigravity 打开；视图与内核按能力判断，不再按 CLI 名字分支。

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
