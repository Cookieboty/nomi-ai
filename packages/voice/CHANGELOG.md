# @nomi-ai/voice

## 0.2.2

### Patch Changes

- Updated dependencies [9447585]
  - @nomi-ai/ui@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [de06bd2]
  - @nomi-ai/ui@0.2.1

## 0.2.0

### Minor Changes

- f6ce860: 语音输入支持流式识别（#61）：按住说话时边录边推送音频、实时显示临时文本（不自动发送），松开后提交最终结果；取消 / 启动中取消 / 新会话开始都会丢弃旧会话的音频和文本。语音设置新增豆包流式语音识别 2.0 区块（API Key 保存 / 替换 / 清除、资源版本、失败回退、需确认的测试连接、联网与计费说明）及英文文案。

### Patch Changes

- e03a2e4: fix(voice): cancelling (release / cancel / unmount / stop) while the microphone or VAD is still starting now sticks — a late `getUserMedia` stream is released immediately, no recording starts, and an old start can no longer change the state of a newer one.
- 843ea26: feat(ui): 图片主题所需的共享主题色、半透明 token、文案与语音面板样式（详见 global-background-image）。
- cdfac34: 修复词典迁移后残留的裸 key：「助手」模式按钮、语音识别语言、屏幕记忆跳过原因、知识库索引进度、提醒星期按钮、桌面操作确认提示等处不再显示 key；诺米语音不再朗读 key；批准计划后发给 agent 的跟进消息、内置技能文件改为翻译后的正文；屏幕记忆默认排除词与默认唤醒词恢复为中文原词，重新能匹配中文窗口标题与语音。
- 7aead16: feat(ui): checkboxes, sliders and number fields are drawn in the app style instead of the system look (new `Checkbox`, `Slider`, `NumberField`; `Input` picks them for `type="checkbox|range|number"`), so they follow the theme on macOS and Windows alike. Number fields get in-app step buttons that appear on hover or focus.
- d4ebe16: 诺米缩小后「更多」面板不再被截断：面板按窗口大小定位，窗口太小时用紧凑排版并可滚动。
  语音状态 / 错误提示改为与气泡一致的深色样式，窗口窄时换行显示，「去设置」直接打开语音设置；诺米里的文字不再会被拖动选中。
  独立的「TTS 语音配置」窗口并入「设置 → 语音与屏幕 → 语音」的「朗读引擎」，
  跟随应用主题；诺米「更多」里重复的入口去掉，「声音设置」里改为「更多语音设置…」链接。
- 8de675f: 整理「语音与屏幕」与「本机管理」：

  - 语音：朗读、朗读引擎、语音输入、本地引擎 / 识别模型、交互、唤醒词各成一组，开关与下拉统一放在右侧；「开启语音」从原生复选框改为开关，未就绪原因单独提示。
  - 屏幕：截图提问、屏幕记忆、排除列表改为分组设置行，「立即记录一次 / 暂停」放到分组右上角，记录列表有标题行，「清空全部记录」不再是孤立的红色按钮。
  - 本机管理：「Ollama」标签并入「本机模型」，内置 llama.cpp 与 Ollama 分组展示并写明两者互不依赖；没检测到 Ollama 时只显示提示；模型列表随页面滚动；剪贴板与数据导出改为分组。
  - 分组卡片里提示条、输入行、列表之间自动留出间距。

- d4ebe16: 界面样式统一（第二轮）：输入栏工具行的所有按钮（更多、插件、后端、模型、权限、语音、发送）统一为同一高度与胶囊形；
  标签栏、对话头部、右上角会话控件各自统一高度、圆角与悬停效果；「新建标签」改用图标；键盘焦点有统一的描边。
  `Select` 新增 `variant`（`ghost` 透明底、`chip` 胶囊），语音按钮新增 `ms` 尺寸，设计令牌补齐 20 / 24 / 32 高度、2 / 6 间距与浮层阴影。
- 2163498: 修复日落橙 / 奶油等浅色主题下选中态与悬停态对比度过低的问题：分段控件、Tab、设置导航和侧栏当前行改用深棕字配暖橙淡底（并加左侧强调条），链接 / 标签 / 图标改用更深的橙棕色；同时补齐各主题的次要文字、主按钮文字、焦点环和图表色，并新增主题对比度自动化测试。
- 2163498: fix: pre-release polish. "Fork as new chat" now shows the copy in the sidebar right away (the list used to refresh only when the message count changed); the mascot speech bubble renders Markdown replies as plain text instead of showing raw `**` / backticks / `#`; the voice error pill ("No microphone found") dismisses itself after a few seconds; the chat hands-free tooltip is no longer clipped at the window's right edge and long mascot toolbar tooltips wrap inside the window (they still open to the left of the bar); the largest mascot size keeps a few pixels of slack to the display work area so it cannot end up 1px taller than the screen after DPI rounding on Windows.
- 7ecf142: feat(voice): `MicButton` 新增无边框的 `variant="bare"`（录音 / 开着时仍用强调色）。/ `MicButton` gains a borderless `variant="bare"` (recording / on states keep the accent).
- 25eb691: 连续按住说话不再丢新录音的流式识别（#70）：上一段松开后还在等云端会话建立时就开始新的一段，上一段收尾时只释放自己的流记录，新一段的音频推送、临时文本和结束识别照常进行；上一段的转写仍照常交付。
- Updated dependencies [cb239f2]
- Updated dependencies [1922999]
- Updated dependencies [5c7fbe9]
- Updated dependencies [75b6f48]
- Updated dependencies [8de675f]
- Updated dependencies [429d2b1]
- Updated dependencies [a937c80]
- Updated dependencies [8de675f]
- Updated dependencies [8de675f]
- Updated dependencies [2163498]
- Updated dependencies [b507a2b]
- Updated dependencies [2163498]
- Updated dependencies [2163498]
- Updated dependencies [2163498]
- Updated dependencies [f1cdeda]
- Updated dependencies [2f6593e]
- Updated dependencies [2163498]
- Updated dependencies [8de675f]
- Updated dependencies [2267792]
- Updated dependencies [df95d1b]
- Updated dependencies [863dad7]
- Updated dependencies [cdfac34]
- Updated dependencies [2267792]
- Updated dependencies [ee25a69]
- Updated dependencies [2163498]
- Updated dependencies [cdfac34]
- Updated dependencies [160db7e]
- Updated dependencies [8c327d1]
- Updated dependencies [843ea26]
- Updated dependencies [a5105d6]
- Updated dependencies [25cfe48]
- Updated dependencies [5b693b4]
- Updated dependencies [cdfac34]
- Updated dependencies [cdfac34]
- Updated dependencies [83ac8f9]
- Updated dependencies [3594ab1]
- Updated dependencies [95a5364]
- Updated dependencies [7aead16]
- Updated dependencies [5dfc2b9]
- Updated dependencies [04e3e3d]
- Updated dependencies [8de675f]
- Updated dependencies [34a8422]
- Updated dependencies [91bcd7c]
- Updated dependencies [9e5b580]
- Updated dependencies [d60a25e]
- Updated dependencies [a8eb3da]
- Updated dependencies [8de675f]
- Updated dependencies [d7938e0]
- Updated dependencies [5d7c06a]
- Updated dependencies [1922999]
- Updated dependencies [12157b2]
- Updated dependencies [92f1e46]
- Updated dependencies [2163498]
- Updated dependencies [2267792]
- Updated dependencies
- Updated dependencies [b82f40f]
- Updated dependencies [ab388c2]
- Updated dependencies [3197adc]
- Updated dependencies [be05ab9]
- Updated dependencies [8de675f]
- Updated dependencies [8de675f]
- Updated dependencies [62e527e]
- Updated dependencies [cd4395d]
- Updated dependencies [2267792]
- Updated dependencies [2267792]
- Updated dependencies [d7938e0]
- Updated dependencies [d7938e0]
- Updated dependencies [cdfac34]
- Updated dependencies [2163498]
- Updated dependencies [2163498]
- Updated dependencies [2163498]
- Updated dependencies [d4ebe16]
- Updated dependencies [d4ebe16]
- Updated dependencies [d4ebe16]
- Updated dependencies [d7938e0]
- Updated dependencies [2163498]
- Updated dependencies [cdfac34]
- Updated dependencies [50a68e8]
- Updated dependencies [2163498]
- Updated dependencies [7ecf142]
- Updated dependencies [cdfac34]
- Updated dependencies [1c1f497]
- Updated dependencies [2163498]
- Updated dependencies [12a9200]
- Updated dependencies [2163498]
- Updated dependencies [2267792]
- Updated dependencies [2267792]
- Updated dependencies [2267792]
- Updated dependencies [2267792]
- Updated dependencies [2267792]
- Updated dependencies [10b8d39]
- Updated dependencies [2267792]
- Updated dependencies [8de675f]
- Updated dependencies [f6ce860]
- Updated dependencies [2267792]
- Updated dependencies [d7938e0]
- Updated dependencies [d7938e0]
  - @nomi-ai/ui@0.2.0
