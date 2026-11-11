# 快速上手 / Getting started

<p align="left"><a href="#中文">中文</a> · <a href="#english">English</a></p>

---

## 中文

Nomi·诺米：让每一种 AI 能力，都为你所用。编程助手、模型、MCP 与技能接到一处，在 Agent 工作台里并行跑、一处看、一起管；Nomi 自己也能聊天、记事、提醒，桌面角色可选，不需要就关掉。

### 安装

从 [GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases/latest) 下载对应系统的安装包（`<版本号>` 即 Release 的版本号）：

| 系统                          | 安装包                    |
| ----------------------------- | ------------------------- |
| macOS · Apple 芯片（M 系列）  | `Nomi-<版本号>-arm64.dmg` |
| macOS · Intel 芯片            | `Nomi-<版本号>.dmg`       |
| Windows 10+（x64）            | `Nomi-Setup-<版本号>.exe` |
| Linux（x64）                  | `Nomi-<版本号>.AppImage`  |
| Linux（x64，Debian / Ubuntu） | `nomi_<版本号>_amd64.deb` |

Linux AppImage：`chmod +x Nomi-<版本号>.AppImage && ./Nomi-<版本号>.AppImage`。

macOS 安装包已签名但尚未公证：若提示「已损坏」，先把 Nomi 拖到「应用程序」，再执行 `sudo xattr -dr com.apple.quarantine /Applications/Nomi.app`。Windows 若弹出 SmartScreen，点「更多信息 → 仍要运行」。

### 首次引导

第一次启动会打开工作台尺寸的对话窗口，引导盖住整个窗口。四步是：**语言和主题 → 接一个模型 → 打开看板 → 桌面角色（默认关闭）**。右上角可以跳过；跳过或完成后会打开看板，空看板上的主按钮是派出 Claude Code 或 Codex。之后可在「设置 → 通用 → 新手引导 → 重新打开」再走一遍。

- **接入模型**：先选第三方供应商（预设或自定义地址），填 Key 后检测并保存；保存好之前模型列表是灰的，之后点一个模型就设为 Nomi 对话用的模型。没接模型就完成引导时，最后一页提示「还差一步：接上模型」，可一键跳到「设置 → 模型与供应商」。
- **职业与兴趣**用来推荐：侧栏的「开始使用」会推荐编程助手（如开发者推荐 Claude Code 与 Codex，其他职业至少推荐 Codex）和功能（知识库、日程提醒、语音、导入 MCP 与技能），欢迎页的示例问题也会随之调整。
- **启动方式**：**桌面诺米**（默认，桌面上先出现诺米，点她的「AI 对话」进入主界面）或**软件主界面**（直接打开主界面，诺米仍在桌面待命，提醒照常播报）。之后在「设置 → 通用 → 启动与窗口」修改。
- **声音**不在引导里设置：默认用 Edge 在线朗读（晓伊，语速 -5%），「朗读 AI 回复」默认开启；没联网时只显示文字。详见 [语音](features/voice.md)。

### 接入一个模型

二选一：

- **云端模型**：「设置 → 模型与供应商 → 第三方供应商」，添加预设（如 DeepSeek、Kimi、OpenRouter）或自定义地址，填入 API Key 后检测并保存，再在「分配」里选 Nomi 对话用的模型。见 [第三方供应商与模型](features/providers.md)。
- **本机模型**：`Ctrl/⌘+Shift+J`（「设置 → 模型与供应商 → 本机模型」）下载一个推荐的小模型并启动，它会自动成为可用的供应商。见 [本地模型](features/local-models.md)。

### 两种模式

会话面板顶部的菜单可以切换 **对话**（聊天、知识库、记忆）与 **工坊**（派出 Claude Code、Codex 等编程助手，改项目、看 Diff）。工坊的三栏布局、改动审查与提交见 [编程助手](features/coding-agents.md)。看板上的终端或 IDE 会话是只读的。

### 常用快捷键

| 快捷键       | 作用                           |
| ------------ | ------------------------------ |
| `Ctrl/⌘+K`   | 命令面板（搜索全部操作与设置） |
| `Ctrl/⌘+N`   | 新对话                         |
| `Ctrl/⌘+L`   | 聚焦输入框                     |
| `Ctrl/⌘+,`   | 打开设置                       |
| `F2`（按住） | 按住说话                       |

完整列表与改键见 [个性化](features/personalization.md#快捷键)。

### 托盘菜单

系统托盘里可以：打开 AI 对话、切换对话模型、打开模型设置、桌面能力（文件授权 / 操作记录）、让诺米做动作、互动设置（穿透 / 重力 / 散步）、退出。

---

## English

Nomi: one place, every AI capability. Coding agents, models, MCP and skills come together in one agent workbench, where they run side by side and you watch and manage them together; Nomi itself also chats, remembers and reminds you, and its desktop character is optional, so close it if you don't need it.

### Install

Download the installer for your system from [GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases/latest) (`<version>` is the Release version):

| System                           | Installer                  |
| -------------------------------- | -------------------------- |
| macOS · Apple Silicon (M-series) | `Nomi-<version>-arm64.dmg` |
| macOS · Intel                    | `Nomi-<version>.dmg`       |
| Windows 10+ (x64)                | `Nomi-Setup-<version>.exe` |
| Linux (x64)                      | `Nomi-<version>.AppImage`  |
| Linux (x64, Debian / Ubuntu)     | `nomi_<version>_amd64.deb` |

Linux AppImage: `chmod +x Nomi-<version>.AppImage && ./Nomi-<version>.AppImage`.

The macOS build is signed but not notarized. If macOS says Nomi “is damaged”, move it into Applications, then run `sudo xattr -dr com.apple.quarantine /Applications/Nomi.app`. If Windows shows SmartScreen, click “More info → Run anyway”.

### First-run onboarding

On first launch the workbench-sized chat window opens with the guide covering the whole window. The four steps are **language and theme → connect a model → open the board → desktop character (off by default)**. Skip from the corner; skipping or finishing opens the board, whose primary action is to dispatch Claude Code or Codex. Rerun it later from Settings → General → Getting started guide → Reopen.

- **Connect a model**: pick a third-party provider (a preset or a custom address), enter the key and check & save; the model list stays greyed out until then, and the model you click becomes Nomi's chat model. If you finish without a model, the last page says “One step left: connect a model” and can jump to Settings → Models & providers.
- **Occupation and interests** drive the recommendations: the sidebar's Get started card suggests coding agents (Claude Code and Codex for developers, at least Codex for everyone else) and features (knowledge base, reminders, voice, importing MCP and skills), and the welcome screen's example questions change to match.
- **Startup mode**: **Desktop nomi** (default; nomi appears on your desktop first, click her “AI chat” to open the main window) or **Main window** (opens straight away while nomi stays on the desktop and reminders still play). Change it later in Settings → General → Startup & windows.
- **Voice** is not part of onboarding: the default is Edge online read-aloud (Xiaoyi, rate -5%) with **Read AI replies aloud** on; offline, Nomi just shows text. See [Voice](features/voice.md).

### Connect a model

Pick one:

- **Cloud model**: Settings → Models & providers → Third-party providers. Add a preset (e.g. DeepSeek, Kimi, OpenRouter) or a custom address, enter an API key and check & save, then pick Nomi's chat model under Assignments. See [Providers & models](features/providers.md).
- **Local model**: `Ctrl/⌘+Shift+J` (Settings → Models & providers → Local models), download a recommended small model and start it; it registers as a provider automatically. See [Local models](features/local-models.md).

### Two modes

Next to the Nomi logo at the top of the sidebar you can switch between **Assistant** (chat with Nomi only) and **Workbench** (adds coding-agent tabs for Claude Code, Codex, Grok, Gemini and dsh). The workbench layout, change review and commits are described in [Coding agents](features/coding-agents.md).

### Common shortcuts

| Shortcut    | Action                                          |
| ----------- | ----------------------------------------------- |
| `Ctrl/⌘+K`  | Command palette (search all actions & settings) |
| `Ctrl/⌘+N`  | New chat                                        |
| `Ctrl/⌘+L`  | Focus input                                     |
| `Ctrl/⌘+,`  | Open settings                                   |
| `F2` (hold) | Push-to-talk                                    |

Full list and remapping: [Personalization](features/personalization.md#快捷键).

### Tray menu

From the system tray you can: open AI chat, switch the chat model, open model settings, open desktop abilities (file grants / activity log), trigger nomi's motions, open interaction settings (click-through / gravity / stroll), or quit.
