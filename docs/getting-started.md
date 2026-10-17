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

第一次启动会打开对话窗口并进入 6 步引导：**界面语言 → 主题 → 角色与声音 → 称呼与语气 → 模型供应商 → 隐私**。
每一步都可以跳过，之后可在「设置 → 重新打开新手引导」再走一遍。

### 接入一个模型

二选一：

- **云端模型**：设置 →「编程助手」→ Nomi →「添加供应商」，选择预设（如 DeepSeek、OpenAI、Kimi），填入 API Key，点「获取模型」后勾选并设为默认。见 [供应商与 Token](features/providers.md)。
- **本地模型**：对话窗口 🏠（`Ctrl/⌘+Shift+J`）→ 下载一个推荐的小模型并启动，它会自动成为可用的供应商。见 [本地模型](features/local-models.md)。

### 常用快捷键

| 快捷键         | 作用                           |
| -------------- | ------------------------------ |
| `Ctrl/⌘+K`     | 命令面板（搜索全部操作与设置） |
| `Ctrl/⌘+N`     | 新对话                         |
| `Ctrl/⌘+L`     | 聚焦输入框                     |
| `Ctrl/⌘+,`     | 打开设置                       |
| `Ctrl/⌘+Alt+A` | 在任意界面截图提问             |
| `F2`（按住）   | 按住说话                       |

完整列表与改键见 [个性化](features/personalization.md)。

### 托盘菜单

系统托盘里可以：打开对话、切换 AI 供应商、打开供应商设置与桌面能力、让 Nomi 做动作、切换角色 / 打开模型商店、调整互动设置、退出。

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

On first launch the chat window opens a 6-step guide: **UI language → theme → character & voice → how to address you & tone → model provider → privacy**.
Every step is skippable; you can rerun it later from Settings → Reopen onboarding.

### Connect a model

Pick one:

- **Cloud model**: Settings → Coding assistants → Nomi → Add provider, choose a preset (e.g. DeepSeek, OpenAI, Kimi), enter an API key, Fetch models, then enable and set default. See [Providers & tokens](features/providers.md).
- **Local model**: chat window 🏠 (`Ctrl/⌘+Shift+J`) → download a recommended small model and start it; it registers as a provider automatically. See [Local models](features/local-models.md).

### Common shortcuts

| Shortcut       | Action                                          |
| -------------- | ----------------------------------------------- |
| `Ctrl/⌘+K`     | Command palette (search all actions & settings) |
| `Ctrl/⌘+N`     | New chat                                        |
| `Ctrl/⌘+L`     | Focus input                                     |
| `Ctrl/⌘+,`     | Open settings                                   |
| `Ctrl/⌘+Alt+A` | Screenshot-and-ask from any screen              |
| `F2` (hold)    | Push-to-talk                                    |

Full list and remapping: [Personalization](features/personalization.md).

### Tray menu

From the system tray you can: open chat, switch AI provider, open provider settings & desktop capabilities, trigger Nomi motions, switch character / open the model store, tweak interaction settings, or quit.
