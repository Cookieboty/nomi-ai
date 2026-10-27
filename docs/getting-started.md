# 快速上手 / Getting started

<p align="left"><a href="#中文">中文</a> · <a href="#english">English</a></p>

---

## 中文

### 安装

从 [GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases/latest) 下载对应系统的安装包（`<版本号>` 即 Release 的版本号）：

| 系统                         | 安装包                    |
| ---------------------------- | ------------------------- |
| macOS · Apple 芯片（M 系列） | `Nomi-<版本号>-arm64.dmg` |
| macOS · Intel 芯片           | `Nomi-<版本号>.dmg`       |
| Windows 10+（x64）           | `Nomi-Setup-<版本号>.exe` |
| Linux（x64）                 | `Nomi-<版本号>.AppImage`  |

Linux AppImage：`chmod +x Nomi-<版本号>.AppImage && ./Nomi-<版本号>.AppImage`。

当前安装包尚未经过签名 / 公证：Windows 若弹出 SmartScreen，点「更多信息 → 仍要运行」；macOS 若提示「已损坏」，先把 Nomi 拖到「应用程序」，再执行 `sudo xattr -dr com.apple.quarantine /Applications/Nomi.app`。

### 首次引导

第一次启动会打开对话窗口并进入 5 步引导：**欢迎与界面语言 → 外观与启动 → 关于你（称呼、职业与兴趣）→ 接上模型 → 隐私与完成**。
每一步都可以跳过，之后可在「设置 → 重新打开新手引导」再走一遍；重新打开时会带出上次填的称呼、职业和兴趣。

「接上模型」在引导里一气呵成：先选第三方供应商（预设或自定义地址），填 Key 后「检测并保存」；供应商配好之前，下面的模型选择是灰的；配好后列出这个供应商的对话模型，点一个就设为 Nomi 对话用的模型。也可以打开完整的模型设置。没接模型就完成引导时，最后一页会提示「还差一步：接上模型」，并可一键跳到「设置 → 模型」。

声音不在引导里设置：新装默认用 Edge 在线朗读（晓伊，语速 -5%），「朗读 AI 回复」默认开启；Edge 朗读需要联网，没联网时只显示文字。可在「设置 → 语音」修改，详见 [语音](features/voice.md)。

「关于你」里的职业与兴趣用来推荐任务：侧栏「开始使用」会推荐适合你的编程助手（如开发者推荐 Claude Code 与 Codex，其他职业都至少推荐 Codex）和功能（知识库、日程提醒、语音、MCP 与技能），欢迎屏的示例问题也会随之调整。编程助手可以同时安装。

「启动方式」决定以后启动 Nomi 先看到什么：**看板娘**（默认，点她的「AI 对话」进入主界面）或**软件主界面**（直接进入主界面，看板娘仍在桌面待命，定时任务和提醒照常播报）。随时可在「设置 → 通用 → 启动 Nomi 后默认显示」修改，设计见 [启动默认界面](design/startup-default-view.md)。

### 编程助手工作台（v1.2.0）

切到「工作台」后是左中右三栏：左侧会话，中间对话，右侧「改动 · 文件」（可收起；分割线可拖动，位置会被记住，双击复位）。助手每轮改了文件，消息下会出现「已编辑 N 个文件」卡片，点「查看变更」在中栏看 Diff，或「全屏审查」逐个文件过一遍；要提交时用右栏的「让助手提交」，它只把指令填进输入框，由你确认后发送。输入栏旁的环形指示是当前上下文占用，悬停查看数值。详见 [编程助手工作台](features/coding-workspace.md)。

### 接入一个模型

二选一：

- **云端模型**：设置 →「模型与供应商」，第 ① 步在页面里直接选预设（如 DeepSeek、OpenAI、Kimi）或自定义地址，填入 API Key 后点「检测并保存」；第 ② 步「模型分配」会列出它的模型，推荐的已默认选好，可以改。见 [供应商与 Token](features/providers.md)。
- **本地模型**：`Ctrl/⌘+Shift+J`（设置 → 模型与供应商 → 本机模型）→ 下载一个推荐的小模型并启动，它会自动成为可用的供应商。见 [本地模型](features/local-models.md)。

### 常用快捷键

| 快捷键       | 作用                           |
| ------------ | ------------------------------ |
| `Ctrl/⌘+K`   | 命令面板（搜索全部操作与设置） |
| `Ctrl/⌘+N`   | 新对话                         |
| `Ctrl/⌘+L`   | 聚焦输入框                     |
| `Ctrl/⌘+,`   | 打开设置                       |
| `F2`（按住） | 按住说话                       |

完整列表与改键见 [个性化](features/personalization.md)。

### 托盘菜单

系统托盘里可以：打开对话、切换 AI 供应商、打开供应商设置与桌面能力、让 Nomi 做动作、调整互动设置、退出。

---

## English

### Install

Download the installer for your system from [GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases/latest) (`<version>` is the Release version):

| System                           | Installer                  |
| -------------------------------- | -------------------------- |
| macOS · Apple Silicon (M-series) | `Nomi-<version>-arm64.dmg` |
| macOS · Intel                    | `Nomi-<version>.dmg`       |
| Windows 10+ (x64)                | `Nomi-Setup-<version>.exe` |
| Linux (x64)                      | `Nomi-<version>.AppImage`  |

Linux: `chmod +x Nomi-<version>.AppImage && ./Nomi-<version>.AppImage`.

The current builds are not signed / notarized. If Windows shows SmartScreen, click “More info → Run anyway”. If macOS says Nomi “is damaged”, move it into Applications, then run `sudo xattr -dr com.apple.quarantine /Applications/Nomi.app`.

### First-run onboarding

On first launch the chat window opens a 5-step guide: **welcome & UI language → look & startup → about you (name, occupation & interests) → connect a model → privacy & finish**. The model step is one inline flow: first choose a provider (a preset or a custom address), enter the key and **Check & save**; the model list stays greyed out until a provider is set up, then lists that provider's chat models — pick one and it becomes Nomi's chat model. A link opens the full model settings; if you finish without a model, the last page says "One step left: connect a model" and can jump straight to Settings → Models. Reopening the guide prefills your saved name, occupation and interests.

Your occupation and interests drive the recommendations: the sidebar's Get started card suggests coding agents (Claude Code and Codex for developers, and at least Codex for everyone else) and features (knowledge base, reminders, voice, MCP and skills), and the welcome screen's example questions change to match. Coding agents can be installed at the same time.
Every step is skippable; you can rerun it later from Settings → Reopen onboarding.

Voice is not part of onboarding. Nothing is downloaded on first run: Nomi's common prompts use built-in prerecorded clips, and the realtime engine defaults to Edge online TTS (Xiaoyi, rate -5%) with **Read AI replies** on by default. Edge TTS needs an internet connection; offline, Nomi just shows text. Change it in Settings → Voice. See [Voice](features/voice.md).

“Startup mode” decides what you see when Nomi starts: the **mascot** (default; click her “AI chat” to open the main window) or the **main window** (opens straight away while the mascot keeps waiting on your desktop, so scheduled tasks and reminders still work). Change it any time in Settings → General → Show on startup. Design: [Startup default view](design/startup-default-view.md).

### Coding-agent workbench (v1.2.0)

Switch to “Workbench” for three columns: sessions on the left, chat in the middle, “Changes · Files” on the right (collapsible; dividers are draggable, remembered, and reset on double-click). When the assistant edits files in a turn, an “Edited N files” card appears under the message: “View changes” opens the diff in the middle column, “Full-screen review” walks through every file. To commit, use “Ask assistant to commit” in the right column — it only fills the instruction into the input box, and you confirm before sending. The ring next to the input is the current context usage; hover for the numbers. See [Coding workspace](features/coding-workspace.md).

### Connect a model

Pick one:

- **Cloud model**: Settings → Models & providers. In step ① pick a preset (e.g. DeepSeek, OpenAI, Kimi) or a custom address right on the page, enter an API key and click Check & save; step ② (model assignments) then lists its models with the recommended one preselected — change it if you like. See [Providers & tokens](features/providers.md).
- **Local model**: `Ctrl/⌘+Shift+J` (Settings → Models & providers → Local models) → download a recommended small model and start it; it registers as a provider automatically. See [Local models](features/local-models.md).

### Common shortcuts

| Shortcut    | Action                                          |
| ----------- | ----------------------------------------------- |
| `Ctrl/⌘+K`  | Command palette (search all actions & settings) |
| `Ctrl/⌘+N`  | New chat                                        |
| `Ctrl/⌘+L`  | Focus input                                     |
| `Ctrl/⌘+,`  | Open settings                                   |
| `F2` (hold) | Push-to-talk                                    |

Full list and remapping: [Personalization](features/personalization.md).

### Tray menu

From the system tray you can: open chat, switch AI provider, open provider settings & desktop capabilities, trigger Nomi motions, tweak interaction settings, or quit.
