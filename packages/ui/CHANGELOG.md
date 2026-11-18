# @nomi-ai/ui

## 0.2.2

### Patch Changes

- 9447585: 修复画布色被误加到所有主题的问题：`--cd-workspace-bg` 之前写在了 `:root, [data-theme='light']` 混合选择器里，选择器中的 `:root` 对任何主题都命中且位置靠后，把其余六个主题的画布一并改成了浅色。现改为只作用于浅色主题。 Fix the canvas colour leaking into every theme: `--cd-workspace-bg` was declared inside the `:root, [data-theme='light']` selector, whose bare `:root` matches all themes, repainting the canvas of the other six themes. It is now scoped to the light theme only.
- Updated dependencies [93daf02]
- Updated dependencies [9d1f087]
- Updated dependencies [35ca37e]
  - @nomi-ai/i18n@0.2.2

## 0.2.1

### Patch Changes

- de06bd2: feat(ui): 浅色主题按设计系统对齐色值，工作区背景改为 #FAF9F6，主题色块同步更新。 Light theme colors aligned with the design system, the workspace background set to #FAF9F6, and the light theme swatch updated to match.
- Updated dependencies [5fe61e1]
- Updated dependencies [b27ece0]
- Updated dependencies [61aa211]
- Updated dependencies [2958f64]
- Updated dependencies [ebd40bf]
- Updated dependencies [1e23f1e]
- Updated dependencies [2958f64]
  - @nomi-ai/i18n@0.2.1

## 0.2.0

### Minor Changes

- 2163498: 新增 Gemini CLI agent 端点：通过 ACP 协议长驻对话（同一标签多轮复用一个进程），支持计划 / 手动 / 自动编辑 / 完全放行四种权限模式与界面审批、停止当前轮次、子代理识别；「Agents」页可检测、安装与更新 Gemini CLI。
- 2163498: 新增「关闭主界面时：隐藏到托盘 / 退出 Nomi」（设置 → 通用，紧挨「启动 Nomi 后默认显示」）。默认隐藏到托盘，与之前一致；选「退出 Nomi」后关闭主界面会完全退出（诺米、托盘一起关闭），macOS 上红色按钮与 ⌘W 同样按此处理，⌘Q 始终退出。另外，由系统登录项自动启动且默认界面为主界面时，主界面现在也会到前台并获得焦点，与普通启动一致。
- 863dad7: 设置 → 外观新增「我的主题」：填强调色、背景、表面、文字 4 个颜色（或一次粘贴一组）即可新建主题，其余颜色自动推导并做对比度修正，编辑时实时预览；可以浅色、深色各配一套跟随系统切换，逐个调整颜色，加背景图；支持导入、导出主题包（`.nomitheme.json`，带背景图时为 `.nomitheme`）。
- a8eb3da: 模型选择器按供应商分标签、按厂商筛选：对话输入栏与 agent 标签的第三方模型按钮，弹层顶部按供应商分标签，可以直接换到别的供应商的模型（agent 原地续接）；右侧按厂商（OpenAI、Anthropic、DeepSeek、Z.ai …）快速筛选，认不出的归到「其他厂商」。
- 1922999: 新增 `isImageModel`（按名字识别生图模型）与 `shortModelName`；模型选择器在浏览模式下去掉厂商前缀、按厂商分组并显示上下文长度。见 nomi-image-generation。
- 8de675f: 整理「日程与日历」「通知 / 灵动岛」「扩展 / MCP」三页：

  - UI 库新增 `SettingsGroup` / `SettingRow`：分组卡片（标题、说明、右上角操作）+「左边标题与说明、右边控件」的设置行。
  - 设置页的内嵌面板不再重复显示与页头同名的标题；页内二级标签统一为下划线样式。
  - 灵动岛分为「灵动岛」与「通知类型」两组，每个开关都有一句说明，「预览一条通知」放在分组右上角。
  - 主动聊天、免打扰与通知、系统日历改为设置行；「显示已结束的提醒」从原生复选框改为开关；日历与 MCP / 技能的工具栏说明可换行、按钮不再被挤到下一行。
  - 技能卡片的「编辑 / 删除」改为卡片右上角的图标按钮，列表里不再每行一个红色实底按钮。

- cd4395d: 设置页按 v1.1.1 视觉稿重排：品牌头与底部标语、统一页头与卡片分组、快捷键「应用内 / 全局」标签、agent 卡片带安装状态，日落橙主题对齐新配色。
- 2163498: 新增「启动 Nomi 后默认显示」：首次引导增加「启动方式」一步（以诺米方式 / 以控制台（主界面）方式打开），「设置 → 通用」可随时修改。默认仍是诺米（老用户升级后行为不变）；选「软件主界面」后启动直接打开主界面，诺米仍在桌面待命，定时任务和提醒照常播报；再次启动 / 点 Dock / 点 Windows 托盘图标会回到主界面，由系统登录项自动启动时主界面不抢占焦点。
- 2267792: v1.2.0：agent 会话支持多模态附图（Claude / Codex / Grok / Gemini；dsh 明确拒绝）、上下文占用条、本轮 Changes 与只读 Git 面板。
- 8de675f: 按「Nomi 视觉色彩系统规范 v1.0」重做五套主题：日落橙（默认）、奶油、冷雾为浅色，暖墨、石墨为深色。

  - 背景、侧栏、表面、文字、边框、选中、主操作（默认 / 悬停 / 按下）全部换成规范的语义色；状态色（成功 / 警告 / 错误 / 信息 / 中性）跨主题一致，深色主题提亮文字、改用半透明浅底。
  - 组件按规范调整：次按钮用独立的底 / 边框 / 文字色，主按钮纯色无阴影并有按下态，危险按钮改为实底白字，禁用态用专门的底色和文字色；开关滑块固定白色、关闭为中性灰；输入框与下拉框聚焦时边框换成焦点色并加外环；选中导航左侧 3px 主色强调线。
  - 规范值对比度不足 WCAG AA 的少数令牌（日落橙 / 奶油主按钮实底、次要文字、浅色主题图表色等）沿同一色相微调到刚好达标，规范原色保留在 `--cd-color-brand`。
  - 标题栏、对话背景默认色同步新的画布色；日程提醒的「取消 / 停止」改为次按钮。

### Patch Changes

- cb239f2: 更新应用图标设置说明的英文文案（#56）。
- 1922999: `Modal` 挂到 `document.body`（对话里点开大图时不再被输入栏挡住），抽屉头部支持额外按钮（`ModalHost.actions`）；见 asset-library。
- 5c7fbe9: fix(ui): 恢复旧主题 id paper → cream 的映射，新增图片主题选图失败的提示文案（详见 background-image-review-fixes）。
- 75b6f48: fix(ui): Kimi 的图标不再只剩一个蓝点（K 原来是白色，在浅色底上看不见）；Claude 模型用 Claude 自己的星芒图标，不再用 Anthropic 的公司标。
- 8de675f: feat(brand): 用户可见的「AI 助手」和角色旧称统一为 Nomi·诺米 / Nomi（设置、引导、工具栏、README、package 描述）；聊天模式名「助手/工作台」不变。
- 429d2b1: feat(brand): 主题名改为浅色、深色、日落橙等，浅色是新安装的默认主题。 / Themes are named Light, Dark, Sunset and so on; Light is the default for new installs.
- a937c80: 新增「完全放开」确认框标签名的英文翻译（#66）。
- 8de675f: 「完全放开」不再弹确认框：在权限下拉里选中即生效，输入框上方显示提示条，可以「退出完全放开」或只关掉提示。切到「完全放开」时，这一轮里还在等确认的工具请求一并放行，不用停掉重来。
- 8de675f: 对话模式改名：「普通 / 开发」改为「助手 / 工作台」（英文 Assistant / Workbench），提示文案同步更新；功能不变。
- 2163498: feat(chat): slash command palette for every conversation (Nomi / Claude Code / Codex / Grok / dsh) — typing `/` opens a grouped, fuzzy-searchable palette (built-in / endpoint / project / user / plugin / Skills) with argument hints and keyboard navigation. Nomi-native commands (`/context` with a progress bar and breakdown, `/cost`, `/status`, `/model`, `/help`, `/diff`, `/clear` / `/new`) run locally and render as system cards inside the conversation instead of being sent to the CLI; documented Claude Code commands (`/compact`, `/init`, `/code-review`, `/security-review`, `/effort`, `/config`) and project / user commands and skills are passed through (Claude) or expanded locally by the main process (Codex / Grok); interactive-only commands and unknown `/xxx` show an explicit hint and are never silently sent to the model (`//` sends a literal slash). A read-only "Plugins / commands" panel lists the commands, Skills, plugins, MCP servers and sub-agents discovered for the current endpoint (file names and frontmatter only — credentials and MCP env / headers are never read). Design and research notes: docs/design/chat-slash-commands.md.
- b507a2b: 构建共享 UI 前清理旧产物，避免词典拆分后旧 en.json 遮蔽新词典，导致英文界面仍显示中文。
- 2163498: feat(chat): redesign the agent conversation view (Codex Desktop-style) — tool calls are now compact rows (lucide icon, action summary, spinner / done / failed state, duration) instead of a green plain-text list; consecutive explore / command / edit calls fold into expandable groups ("Explored 3 files, 5 searches"), commands show their output, edits render a coloured diff with +/- stats, sub-agents and thinking are collapsible blocks, permission requests stay a prominent card, assistant text renders Markdown, the footer shows a "Working…" indicator, and auto-scroll follows only while the user is at the bottom (with a jump-to-latest button). The main process now records tool arguments / output / thinking / sub-agent parents (Claude, Codex, dsh, Grok) and persists a bounded trace on each assistant message.
- 2163498: feat(cli): add Grok Build as an agent endpoint — detect/install (`grok update` + npm `@xai-official/grok`), headless `streaming-json` harness, per-endpoint provider store that patches `~/.grok/config.toml` with an env_key (key injected only at launch), usage from `sessions/**/updates.jsonl` turn_completed rows, and endpoint glyph. Quota UI treats Grok as API billing; sidebar history for Grok is deferred.
- f1cdeda: 移除模型浮层不再使用的思考深度说明文案（英文词条）。
- 2f6593e: 使用官方账号登录后，可在输入栏直接切换模型与思考深度（Codex / Claude Code / Grok）：新增一枚「模型 · 思考深度」按钮（参考 Codex：浮层大字显示当前档位，下方「模型名 ›」进入模型列表，可选默认模型 / CLI 列出的模型 / 自定义模型 id，再下方用分档滑杆调思考深度）。模型列表、每个模型支持的档位与默认档位全部从 CLI 自己读取、不写死：Claude Code 读 stream-json `initialize` 的模型列表（与 `/model` 一致），Codex 读 `codex debug models` 与 config.toml 的默认模型 / 档位，Grok 读 `grok agent stdio`（ACP）的模型列表；切换账号或供应商后重新读取，读不到时只保留默认模型与自定义 id。设置按标签保存、下一条消息起生效，以进程级参数注入（codex `exec -c`、grok `-m` / `--reasoning-effort`、claude `--model` / `--effort`，Claude 长驻进程空闲时重启复用），不改写用户的全局 CLI 配置；非推理模型自动隐藏思考深度，第三方供应商激活时仍由供应商管理模型（按钮隐藏，标签覆盖也不再注入）；Claude 有后台任务时切换不会中断它们，等后台结束后的下一条消息再生效。Gemini（ACP）/ dsh 暂无无头覆盖参数，不显示按钮。
- 8de675f: 附加的图片改到输入框内部、文本区上方显示（与 Codex 一致），点缩略图可以放大查看原图（Esc 关闭）。
- 2267792: 修复输入栏上下文环与 /context 的用量：改为取这一轮最后一次模型请求的输入 + 输出（Claude Code、Codex、Grok、Gemini、dsh 与 Nomi 各按实测口径），不再把整轮累计当成当前上下文；窗口大小优先用 CLI 上报值（如 Claude 1M）。dsh 现在也会显示用量。
- df95d1b: refactor(core): per-instance `CoreScope` (locale, verbose logging, private root, `CliTrace`) replaces module-level state; `ContractError` is matched by name and code; `persona.systemPrompt` returns the kernel-built prompt. `personaSchema` gains an optional `pronoun`, with `personaPronoun` / `pronounForms` helpers and neutral 它 / it defaults.
- cdfac34: feat(delegate): A1 AgentProfile——delegate_to_cli 支持 profile/model/reasoning_effort，设置默认委派档位与 cheap 模型，createTab 传入 modelOverride。
- 2267792: 中栏 / 全屏审查 / 文件预览的 Diff 在宽度够（≥ 900px）时左右并排，头部可切回单列并全局记住；
  文件预览的「文件」改名「编辑」，Markdown 文件多一个「预览」模式（渲染未保存的草稿）；
  修复切换 Diff / 编辑 / 预览后草稿可能丢失，以及窗口重新聚焦时预览被重置回 Diff。
- ee25a69: fix(ui): 带搜索的下拉框（如模型选择）里，搜索框上下留出更多间距，Windows 上不再显得拥挤。
- 2163498: fix(chat): the slash-command palette (and the other menus that pop up from the input box) no longer sits underneath the message text. The chat background feature gave every chat-area child `z-index: 1` while the input area had no z-index, so the whole input area — including its popups — was painted below the messages; the input area now has an explicit higher layer (`--cd-z-chat-input`) and the chat container is its own stacking context.
- cdfac34: 上游出站统一钉 IP 的 undici Agent（防 DNS 重绑定 TOCTOU），有 HTTP(S)_PROXY 时走 EnvHttpProxyAgent；入站请求体默认 32 MiB 上限（可在模型页高级设置调整，超限 413）；网关子进程滑动窗口崩溃熔断（60 秒内 5 次失败停止自动重启，「重试」清零）。
- 160db7e: Product polish: Gemini / dsh reasoning-effort UI is disabled with clear copy (no documented control); non-reasoning models show「当前模型无思考深度」. ProviderRouter.isKeyError prefers HTTP status codes (401/402/403/429) before message regex; describeStreamError prefixes HTTP status so stream key-rotation can use the same rule.
- 8c327d1: English translations for the Gemini "Trust this folder" action in the chat error card.
- 843ea26: feat(ui): 图片主题所需的共享主题色、半透明 token、文案与语音面板样式（详见 global-background-image）。
- a5105d6: feat(cli-providers): separate Claude/Codex provider stores, upstream API formats, and local routing UI strings.
- 25cfe48: feat(chat): one provider page per endpoint, CLI history in the sidebar, unified new/conversation menus, endpoint icons and workspace picker UI strings.
- 5b693b4: i18n: English strings for agent harness backend switcher and CLI update panel.
- cdfac34: 修复界面卡顿：翻译每次都要重新合并整张词典（几千条），模型页展开「各档模型 / 更多」、切换下拉等操作要几百毫秒；词典改为按语言缓存，模型页展开从约 300ms 降到约 10ms。下拉菜单的说明过长时省略显示，不再出现横向滚动条；「新标签默认用」的说明精简为「不经 Nomi」。
- cdfac34: 修复词典迁移后仍残留的裸 key：Nomi 对话的人设提示发给模型时是 key；诺米气泡（提示、问候、触摸反应、整点报时）显示 key；日历同步失败信息、本地 llama.cpp 供应商名、从 MCP 预设新建的服务器名存成了 key；下拉框按 key 而不是显示文字搜索，分组标题未翻译。中文语音识别的引导词固定为中文，唤醒词保持为原文数据、不随界面语言翻译。
- 83ac8f9: `IconButton` 不再写原生 title，也不再接受 `title` prop：图标按钮的可访问名只走 aria-label（docs/development/frontend-standards.md「无障碍与提示」）；清掉只用于悬停提示的中英文案 key。
- 3594ab1: feat(ui): date and time fields (schedule times, quiet hours, reminder time, quality date range) open Nomi's own calendar / hour-minute picker instead of the system one, with keyboard navigation and the interface language (new `DateTimeField`; `Input` picks it for `type="date|time|datetime-local"`).
- 95a5364: feat(ui): collapsible sections (error details, Git output, knowledge-base sources, referenced memories) use an in-app `Disclosure` with a themed arrow instead of the system `<details>` triangle.
- 7aead16: feat(ui): checkboxes, sliders and number fields are drawn in the app style instead of the system look (new `Checkbox`, `Slider`, `NumberField`; `Input` picks them for `type="checkbox|range|number"`), so they follow the theme on macOS and Windows alike. Number fields get in-app step buttons that appear on hover or focus.
- 5dfc2b9: feat(ui): hover tooltips everywhere (buttons, icons, truncated names — anything with a `title`) now use Nomi's own tooltip instead of the system one, in both the chat window and the Nomi window. It follows the theme, appears after a short pause (instantly when moving along a toolbar), shows for keyboard focus too, and hides on click, scroll or Esc.
- 04e3e3d: 新增知识库引用按钮无障碍标签的英文翻译（#65）。
- 8de675f: 整理「设置 → 知识与记忆」：

  - 去掉与标签重名的面板标题（只留给读屏），页内二级标签改为下划线样式，与外层标签区分层级；统计改为一条分栏条。
  - 「向量与重排」「OCR 识别」「设置与导出」统一为分组卡片：左边标题和说明、右边开关 / 下拉 / 按钮；OCR 语言数据和清除、导出、重置都放进分组的设置行里。
  - 知识库来源一栏的按钮统一为同一高度，空状态不再重复「选择文件夹」按钮。
  - UI 库：`Tabs` 新增 `variant="underline"`；内嵌面板的宿主可设 `hideTitle`。

- 34a8422: 新增 / 更新「显示诺米」开关相关的英文文案（#55）。
- 91bcd7c: 新增「从其他工具导入」对话框的英文文案（#58）。
- 9e5b580: feat(ui): `BrandIcon` 加 `inline`（和文字排在一行：透明底，图形与同尺寸的 lucide 图标一样大；原色有黑 / 白的品牌按单色显示），`ModelPicker` 当前值与厂商栏用它。/ `BrandIcon` gets `inline` (transparent, glyph sized like a lucide icon of the same size, brands with black / white parts render single-colour); `ModelPicker` uses it for the current value and the vendor column.
- d60a25e: fix(ui): the model picker no longer shows capabilities (reasoning · vision · context) next to each model, which truncated model names; they appear in a hover tooltip with the full name instead. Dropdown options and the trigger now use an in-app tooltip (new `FloatingTip`) instead of the system `title` tooltip, shown beside the menu after a short pause on mouse hover or arrow-key navigation. `SelectOption` gains a hover-only `hint`.
- 8de675f: 设置页版面与 Claude Code 后台模型：

  - 「模型」页各卡片统一列宽，选择框、表头与供应商列表的数字列上下对齐；子项只缩进标签。
  - Claude Code 单独的「小模型」并入「Haiku 档 · 后台任务」。启动时 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 与 `ANTHROPIC_SMALL_FAST_MODEL` 取同一个值，修复新版 Claude Code 后台任务不用所设小模型的问题；旧配置里的小模型继续生效。
  - 「通用」页顶部横幅高度封顶，宽窗口下不再越拉越高。

- d7938e0: 为共享按钮补充 32px 尺寸及导航外观，统一导航图标、点击区域与悬浮反馈。
- 5d7c06a: 弹窗、下拉菜单与提示打开时不再有淡入 / 弹出动画，弹窗遮罩不再模糊背景，改为纯半透明遮罩（两套暖色浅色主题的遮罩略加深以保持对比）。
- 12157b2: feat(ui): 统一共享控件的圆角、分层阴影、内高光和按压动效，调整品牌图标比例。
- 92f1e46: Permission PR3: Claude `ExitPlanMode` (and mapped CLIs) surfaces an 「批准计划」card — approve and auto-edit / approve with step-by-step confirm / keep editing. Approve allows the tool and writes back the chosen permission mode; reject stays in plan mode. Codex/dsh/Grok offer a post-turn 「按此方案执行」card. `HarnessEvent` permission gains optional `kind`/`toolName`; status may carry `permissionMode` for label sync. Design: docs/design/cli-permission-modes.md §5.
- 2163498: Remove system speech fallback from TTS. TTS failures now stay silent.
- 2267792: 右栏把「变更」和「未提交」合并为「改动」：git 仓库里以 git 状态为准，分「已暂存 / 未暂存」两组，
  助手本会话改过的文件带标记，可只看本会话；底部「让助手提交 / 提交并推送」把提交指令填进输入框，确认后再发。
- 系统开启「减少动态效果」时，所有加载转圈、录制红点、进度条和过渡动画都会停下；agent 监视只在会话状态有变化时才通知界面，不再每 8 秒空刷一次，「最后活动」时间由面板自己走时。
- b82f40f: fix: `Modal` 新增 `layer="top"`（`--cd-z-modal-top`），确认 / 输入框盖在引导等整页浮层之上。命令自动审核：MCP 工具、`memory_search`、`skill_load` / `skill_read_file` 的返回也把本轮标为读过外部内容（之后中风险命令交给人确认）；审核结论逐个解析配平的 JSON 片段，不再用贪婪正则，多段结论取风险最高的。素材库排序用 birthtime 与 mtime 中较早的一个。Node 与 Go 版一致。
- ab388c2: docs(ui): the generic `>_` endpoint glyph is now described as the icon for non built-in CLIs (see remove-external-cli).
- 3197adc: feat(contract): 增加对话窗口专用的文件预览、目录、修订保存与外部资源契约，补齐预览与图片操作的主题令牌和中英词条。
- be05ab9: 补充上下文窗口估算提示与撤销确认的英文文案。
- 8de675f: 整理「语音与屏幕」与「本机管理」：

  - 语音：朗读、朗读引擎、语音输入、本地引擎 / 识别模型、交互、唤醒词各成一组，开关与下拉统一放在右侧；「开启语音」从原生复选框改为开关，未就绪原因单独提示。
  - 屏幕：截图提问、屏幕记忆、排除列表改为分组设置行，「立即记录一次 / 暂停」放到分组右上角，记录列表有标题行，「清空全部记录」不再是孤立的红色按钮。
  - 本机管理：「Ollama」标签并入「本机模型」，内置 llama.cpp 与 Ollama 分组展示并写明两者互不依赖；没检测到 Ollama 时只显示提示；模型列表随页面滚动；剪贴板与数据导出改为分组。
  - 分组卡片里提示条、输入行、列表之间自动留出间距。

- 62e527e: 内嵌弹窗（.cd-modal--inline）在纵向 flex 宿主里撑满剩余高度，支持顶部固定、内容滚动。
- 2267792: 侧栏端点筛选改成一行：「全部」+ 各端图标，点一下即切换，数量放在悬停提示里；本机历史并进同一列表，没有历史时不再显示空分组；筛选行一次最多显示 5 个端点，其余收进「+N」，默认按对话数从多到少排列，可在显示设置里拖拽（或 Alt+↑/↓）自定义顺序
- 2267792: 删除顶栏左上角的常驻入口（「⋯」菜单与设置里的「常驻入口」）；助手 / 工作台切换移到侧栏 Nomi 标志右侧，搜索、新对话与历史刷新并到列表标题行；本机历史行的第三方供应商标签只显示首字母，不再把时间挤到第二行；设置、知识 · 记忆 · 日程、扩展、本机管理移到侧栏底部（收起时竖排），顶栏只留对话标签与变更栏开关，「+」紧跟最后一个标签；启动时清掉旧版常驻入口留在本机的设置；侧栏收起按钮移到窗口标题栏（macOS 紧跟红绿灯），侧栏顶部的 Nomi 标志与助手 / 工作台切换加大
- d7938e0: 增加导航状态色令牌，补充 DeepSeek Harness 完整名称，并更新侧栏显示设置说明。
- d7938e0: fix(ui): 补充品牌图标透明展示的前景色信息，保留品牌色并适配深浅主题。
- cdfac34: `/cli` 改名为 `/agent`（旧名 `/cli` 仍可用，但不再出现在面板和提示里）；敲 `/agent ` 后列出 agent 供补全：已安装的在前、没安装的置灰不可选，按名字前缀过滤，↑↓ 选择、Enter / Tab 选用、Esc 关闭，输入法组合中不触发。
- 2163498: fix(chat): results of slash commands that finish asynchronously (skill expansion, /diff, /context and the other cards, error notices) now always go back to the conversation that started them. Switching tabs while a command is running no longer sends the expanded prompt, or shows the card or error, in the other tab or the Nomi chat; if the original tab was closed or reset the result is discarded (with a notice when the conversation still exists). The input box is only cleared when you are still in the conversation that ran the command.
- 2163498: fix(chat): when two custom slash commands / skills share a name (project vs user, custom vs built-in, or a Grok bundled skill), the one that loses the bare name used to be shown as `/project:foo` but still sent `/foo`, so a different command ran. Claude Code and Grok have no verified syntax to target the other version, so those entries now stay in the menu marked "Unavailable" with the reason, and selecting or typing them shows an explanation instead of sending anything. The winner keeps the bare name, matching the CLI's own precedence. Codex (expanded by Nomi by id) and Nomi are unchanged.
- d4ebe16: 界面样式修正：诺米「选择角色」卡片在浅色主题下角色名看不清、选中描边不随主题的问题已修复；命令面板等处的高亮颜色跟随主题；
  对话区右上角的工作目录、供应商下拉与设置按钮统一为同一尺寸与样式；修复几处不生效的过渡动画。
- d4ebe16: 界面样式统一（第二轮）：输入栏工具行的所有按钮（更多、插件、后端、模型、权限、语音、发送）统一为同一高度与胶囊形；
  标签栏、对话头部、右上角会话控件各自统一高度、圆角与悬停效果；「新建标签」改用图标；键盘焦点有统一的描边。
  `Select` 新增 `variant`（`ghost` 透明底、`chip` 胶囊），语音按钮新增 `ms` 尺寸，设计令牌补齐 20 / 24 / 32 高度、2 / 6 间距与浮层阴影。
- d4ebe16: 界面样式统一（第三轮）：所有弹出菜单与浮层统一圆角、内边距、阴影与菜单项行高，选中 / 悬停效果一致；
  6 处分段页签统一尺寸与选中样式；引导页、扩展面板的输入框与按钮改用标准尺寸；字号、圆角、间距、字重收敛到设计令牌；
  侧栏状态点、上下文占用图、错误页与共享组件里写死的颜色改为跟随主题。
- d7938e0: 通用图标改为按需引入 Tabler，更新 LobeHub 品牌图标并保留混色品牌的主题适配与彩色细节，补充透明的 Codex 彩色标识。
- 2163498: 修复日落橙 / 奶油等浅色主题下选中态与悬停态对比度过低的问题：分段控件、Tab、设置导航和侧栏当前行改用深棕字配暖橙淡底（并加左侧强调条），链接 / 标签 / 图标改用更深的橙棕色；同时补齐各主题的次要文字、主按钮文字、焦点环和图表色，并新增主题对比度自动化测试。
- cdfac34: token 数一律抹零显示，不再四舍五入：模型标签、上下文提示、会话列表与用量面板里 1,050,000 显示为 1M 而不是 1.1M，999,999 显示为 999K 而不是 1M。
- 50a68e8: fix(ui): toolbar and chat-header tooltips stay inside the window, and several colors now follow the theme tokens (tool rows brighten on hover, context ring uses warning / danger colors).
- 2163498: 修复「普通 / 开发」切换提示文字溢出、压到侧栏上的问题：较长的提示会按最大宽度换行，贴着左边缘的提示改为左对齐显示。
- 7ecf142: feat(ui): `Select` 新增无边框的 `variant="bare"`；滚动条滑块平时透明，鼠标移到可滚动区域上才显示（全局只此一条规则）。/ `Select` gains a borderless `variant="bare"`; scrollbar thumbs stay transparent until the scrollable area is hovered (the only global scrollbar rule).
- cdfac34: 界面渲染优化：模型页的额外选项不再每次渲染都让所有模型选择器重算选项；供应商详情输入 / 勾选、记忆面板筛选只重渲染变化的行；下拉菜单悬停只更新高亮的两行；列表里的日期格式化器复用。
- 1c1f497: agent 标签的模型选择改用与 Nomi 对话同一个模型下拉（共享的 ModelPicker）：搜索框、供应商标签、厂商筛选、每一行的样式与能力提示都一致，不再是两套各自画的列表；官方账号选择也改用共享的下拉；供应商编辑里「按哪个已知模型处理」同样改用这个模型下拉（行右侧显示标准 / 长上下文窗口）。Node 版与 Go 版一致。
- 2163498: feat(chat): one shared conversation view for Nomi and every agent — Nomi chat (including its tool calls, reasoning, sources and memories) now renders through the same component as Claude Code / Codex / Grok / dsh. Adds streaming thinking blocks with a timer ("Thought for N s" when done), explicit waiting states (queued, waiting for permission, first token, retry / reconnect, context compaction, sub-agent, interrupted), per-minute message times with full time on hover, per-turn duration / token / cost summary, copy / regenerate / edit-and-resend / stop actions, an error card with retry, long-conversation paging, and a message queue while a turn is running. History transcripts now carry tool arguments, output, duration and usage. Fixes the lag introduced by the previous conversation view (batched live events, memoised rows, incremental Markdown, bounded trace) and treats Claude `result.is_error` as an error instead of a normal reply.
- 12a9200: 将多语言词典集中到 `@nomi-ai/i18n`，按语言、项目和模块管理稳定 key；移除中文原文 key 与旧兼容映射，并增加缺失翻译、占位符、重复基准文案与死 key 检查。
- 2163498: fix: pre-release polish. "Fork as new chat" now shows the copy in the sidebar right away (the list used to refresh only when the message count changed); the mascot speech bubble renders Markdown replies as plain text instead of showing raw `**` / backticks / `#`; the voice error pill ("No microphone found") dismisses itself after a few seconds; the chat hands-free tooltip is no longer clipped at the window's right edge and long mascot toolbar tooltips wrap inside the window (they still open to the left of the bar); the largest mascot size keeps a few pixels of slack to the display work area so it cannot end up 1px taller than the screen after DPI rounding on Windows.
- 2267792: 打开变更旁栏时对话列默认更宽（主阅读区，过窄历史值回退）；少文件（≤3）摘要卡内展开行级 Diff，多文件才用缩小列表。
- 2267792: 对齐 Codex 整页左中右：中栏「变更」Diff（多文件、未修改行折叠），右栏仅文件树；修复上下文环用量；删除「最多同时运行」。
- 2267792: 右栏完整 cwd 树（变更 +/−/蓝点）、全屏 Review 显式入口、chat↔rail 与 Diff|树水平分割线（可拖/持久化/双击复位）、预览|工作区|分栏切换；composer 加高；发送钮旁上下文环默认只显示环形，悬停再展示「当前上下文 xK / 最大」。
- 2267792: 纠正误删：恢复 Codex 思考档 ultra/「极限」。API 有 max；Codex CLI/Desktop 另有 client 档 ultra（推理侧映射 max + multi-agent）。normalizeEfforts 保留 CLI 返回的 ultra；传 CLI 时原样传 model_reasoning_effort="ultra"。取代错误的 v120-drop-ultra-reasoning。
- 10b8d39: fix(workspace): 撤销/丢弃本轮变更只把改动处换回旧内容，文件之后又被改过则拒绝，不再用一小段 diff 覆盖整个文件；预览面板的丢弃改为应用内确认；全屏 Review 按 Esc 只关全屏；拖过的对话列宽会被记住；中间预览栏不再被挤到看不见保存按钮。
- 2267792: 对照 Codex Desktop：助手消息下「已编辑 N 个文件」摘要卡（路径 +/−、「再显示」、查看变更、确认后撤销本轮写入），以及三栏完整变更工作台（左来源汇总、中行级 Diff、右目录树），与 SessionChangesPanel / 预览打通。
- f6ce860: 语音输入支持流式识别（#61）：按住说话时边录边推送音频、实时显示临时文本（不自动发送），松开后提交最终结果；取消 / 启动中取消 / 新会话开始都会丢弃旧会话的音频和文本。语音设置新增豆包流式语音识别 2.0 区块（API Key 保存 / 替换 / 清除、资源版本、失败回退、需确认的测试连接、联网与计费说明）及英文文案。
- 2267792: 工作区：右栏「变更 · 未提交 · 文件」默认收起、可随时收起，顶栏开关显示变更数；所有 Diff 与文件预览统一在中栏查看；文件树按相对路径并合并单子目录；全屏审查改为全部文件依次排开 + 文件树；面板字号上调、代码 13px；摘要卡默认只列文件。
- d7938e0: 补充内容区背景、阴影及分隔线主题令牌，更新单按钮显示设置说明。
- d7938e0: 内容区域阴影拆分为上方和左侧两层柔和阴影，并使用主题遮罩色保持较轻的视觉重量。
- Updated dependencies [bf74f72]
- Updated dependencies [1ec2af9]
- Updated dependencies [5a60967]
- Updated dependencies [3cf04b1]
- Updated dependencies [4d33393]
- Updated dependencies [5c7fbe9]
- Updated dependencies [40ee48a]
- Updated dependencies [3e9c99b]
- Updated dependencies [a613d29]
- Updated dependencies [632d3ed]
- Updated dependencies [cdfac34]
- Updated dependencies [13364fa]
- Updated dependencies [d386961]
- Updated dependencies [6448028]
- Updated dependencies [a98d631]
- Updated dependencies [996e717]
- Updated dependencies [ba7efe1]
- Updated dependencies [9165114]
- Updated dependencies [6cf63e7]
- Updated dependencies [7ad369f]
- Updated dependencies [4070aab]
- Updated dependencies [4070aab]
- Updated dependencies [13364fa]
- Updated dependencies [c0bc9ac]
- Updated dependencies [d7938e0]
- Updated dependencies [df95d1b]
- Updated dependencies [863dad7]
- Updated dependencies [74a9875]
- Updated dependencies [496f39e]
- Updated dependencies [6448028]
- Updated dependencies [c1fd479]
- Updated dependencies [1ec2af9]
- Updated dependencies [1ec2af9]
- Updated dependencies [6448028]
- Updated dependencies [843ea26]
- Updated dependencies [cdfac34]
- Updated dependencies [0211be6]
- Updated dependencies [8d9ceed]
- Updated dependencies [cdfac34]
- Updated dependencies [83ac8f9]
- Updated dependencies [92ab896]
- Updated dependencies [3594ab1]
- Updated dependencies [65304a3]
- Updated dependencies [5da0b31]
- Updated dependencies [0211be6]
- Updated dependencies [51a4f3f]
- Updated dependencies [cdfac34]
- Updated dependencies [e916b9e]
- Updated dependencies [ab0a3db]
- Updated dependencies [568c407]
- Updated dependencies [9a46790]
- Updated dependencies [6448028]
- Updated dependencies [c7f967c]
- Updated dependencies [f2a3fe3]
- Updated dependencies [6448028]
- Updated dependencies [6448028]
- Updated dependencies [9e5b580]
- Updated dependencies [0b1cd1a]
- Updated dependencies [496f39e]
- Updated dependencies [d46f07e]
- Updated dependencies [db80457]
- Updated dependencies [ab388c2]
- Updated dependencies [496f39e]
- Updated dependencies [010c6a1]
- Updated dependencies [6448028]
- Updated dependencies [3197adc]
- Updated dependencies [6841bef]
- Updated dependencies [1a30b01]
- Updated dependencies [1ec2af9]
- Updated dependencies [145cb39]
- Updated dependencies [1ec2af9]
- Updated dependencies [1ec2af9]
- Updated dependencies [d7938e0]
- Updated dependencies [6448028]
- Updated dependencies [53a474c]
- Updated dependencies [b7cf717]
- Updated dependencies [85b017c]
- Updated dependencies [342aaa9]
- Updated dependencies [6448028]
- Updated dependencies [d7938e0]
- Updated dependencies [c6d6b2c]
- Updated dependencies [429d2b1]
- Updated dependencies [79641ea]
- Updated dependencies [d7938e0]
- Updated dependencies [4e2760c]
- Updated dependencies [18b4428]
- Updated dependencies [f053e05]
- Updated dependencies [88bcadc]
- Updated dependencies [332abab]
- Updated dependencies [11d32fa]
- Updated dependencies [9fdb8d3]
- Updated dependencies [12a9200]
- Updated dependencies [2d5f553]
- Updated dependencies [2b714ef]
- Updated dependencies [4070aab]
- Updated dependencies [fb84243]
- Updated dependencies [d7938e0]
- Updated dependencies [cdfac34]
  - @nomi-ai/i18n@0.2.0
