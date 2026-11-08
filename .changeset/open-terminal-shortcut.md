---
'@nomi-ai/desktop-go': patch
---

feat(chat): 新增快捷键「在终端打开当前项目」：macOS ⇧⌘C，Windows / Linux Ctrl+Shift+C（可在设置里改）。在当前会话的项目目录打开终端（macOS 终端、Windows Terminal 或 PowerShell、Linux 常见终端）；没有项目目录或目录不符合工作区规则时给出提示。/ New shortcut "Open project in terminal": ⇧⌘C on macOS, Ctrl+Shift+C on Windows / Linux (configurable in Settings). Opens a terminal in the current conversation's project folder (Terminal on macOS, Windows Terminal or PowerShell, common Linux terminals); shows a notice when there is no project folder or it isn't allowed as a workspace.
