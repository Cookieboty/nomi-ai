# Nomi 文档 / Nomi Docs

<p align="left"><a href="#中文">中文</a> · <a href="#english">English</a></p>

---

## 中文

Nomi·诺米 是运行在你电脑上的桌面 AI 伙伴（**你的桌面 AI 伙伴** —— 住在桌面，懂你所想，帮你做到。）。这里按功能模块介绍怎么用，每篇末尾附少量技术说明。

### 开始

- [快速上手](getting-started.md)：安装、首次引导、添加模型、常用快捷键

### 功能

| 模块                                                       | 说明                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| [桌面伙伴 Nomi](features/mascot.md)                        | 角色、表情与互动                                     |
| [AI 对话](features/chat.md)                                | 对话窗口、图片与截图提问、命令面板                   |
| [斜杠命令](features/slash-commands.md)                     | 输入 / 弹出命令面板，/context /status 等在界面内执行 |
| [第三方供应商与模型](features/providers.md)                | 预设、自动检测协议、一键切换、多 Key、按任务分配模型 |
| [知识库](features/knowledge-base.md)                       | 基于你的文件夹与笔记回答，并给出引用                 |
| [长期记忆](features/memory.md)                             | 对话记忆、关于我、用户档案                           |
| [日程与日历](features/scheduling-calendar.md)              | 提醒、定时任务、主动聊天、免打扰、系统日历           |
| [屏幕问答](features/screen-qa.md)                          | 截图提问、图片附件、屏幕记忆                         |
| [MCP 与技能](features/mcp-skills.md)                       | MCP 服务器管理、SKILL.md 技能包                      |
| [本地模型](features/local-models.md)                       | 一键下载运行开源小模型、Ollama 管理、离线模式        |
| [自动化与桌面能力](features/automation.md)                 | 文件、笔记、提醒、剪贴板、受控浏览器、代码沙箱       |
| [语音](features/voice.md)                                  | 语音输入、免按键对话、唤醒词、语音播报与自定义 TTS   |
| [编程助手监视](features/agent-monitor.md)                  | Claude Code、Codex、Cursor 等的进度提醒              |
| [编程助手接入（设计稿）](features/coding-agent-harness.md) | 会话接管、CLI 供应商切换、版本更新（待审）           |
| [编程助手工作台（v1.2.0）](features/coding-workspace.md)   | 三栏工作区、改动 · 文件、全屏审查、上下文环、附图    |
| [灵动岛通知](features/dynamic-island.md)                   | macOS 刘海处的通知                                   |
| [个性化](features/personalization.md)                      | 主题、应用图标、快捷键、语言、无障碍                 |
| [自动更新](features/auto-update.md)                        | 后台检查与确认安装                                   |
| [隐私与安全](features/privacy-security.md)                 | 数据保存位置、仅本地模式、权限确认、数据导出         |

### 开发

- [架构概览](development/architecture.md)
- [前端工程规范](development/frontend-standards.md)
- 设计稿：[订阅额度卡片（含 CPA 调研）](design/usage-quota-cards.md)、[按端信息卡](design/endpoint-info-card.md)、[编程助手权限模式](design/cli-permission-modes.md)、[编程助手子代理](design/cli-subagents.md)、[官方账号与 Gemini 接入](design/cli-official-accounts.md)、[编程助手插件化与网关分层适配](design/cli-plugin-architecture.md)
- [构建与运行](development/building.md)
- [测试](development/testing.md)
- [CI 触发规则](development/ci.md)
- [发布](RELEASE.md)：打包、签名与公证（含 CI secret 名称）
- [品牌规范](BRAND.md)：素材在 [`brand/`](brand/)，截图在 [`screenshots/`](screenshots/)

---

## English

Nomi is your desktop AI companion (**Your desktop AI companion** — lives on your desktop, gets what you mean, and gets it done.). These pages explain how to use each feature module; each article ends with a short technical note.

### Getting started

- [Getting started](getting-started.md): install, first-run onboarding, add a model, common shortcuts

### Features

| Module                                                            | About                                                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Desktop companion Nomi](features/mascot.md)                      | Character, expressions & interaction                                              |
| [AI chat](features/chat.md)                                       | Chat window, image & screenshot Q&A, command palette                              |
| [Slash commands](features/slash-commands.md)                      | `/` palette; /context, /status etc. run inside the UI                             |
| [Providers & models](features/providers.md)                       | Presets, protocol detection, one-click switch, multi-key, per-task models         |
| [Knowledge base](features/knowledge-base.md)                      | Answer from your folders & notes with citations                                   |
| [Long-term memory](features/memory.md)                            | Chat memories, About me, user profile                                             |
| [Schedule & calendar](features/scheduling-calendar.md)            | Reminders, jobs, proactive chat, DND, system calendar                             |
| [Screen Q&A](features/screen-qa.md)                               | Screenshot ask, image attachments, screen memory                                  |
| [MCP & skills](features/mcp-skills.md)                            | MCP server management, SKILL.md packs                                             |
| [Local models](features/local-models.md)                          | One-click small models, Ollama management, offline mode                           |
| [Automation & desktop caps](features/automation.md)               | Files, notes, reminders, clipboard, controlled browser, sandbox                   |
| [Voice](features/voice.md)                                        | STT, hands-free, wake word, TTS & custom voice                                    |
| [Coding-agent monitor](features/agent-monitor.md)                 | Progress bubbles for Claude Code, Codex, Cursor, and more                         |
| [Coding-agent harness (design)](features/coding-agent-harness.md) | Session takeover, CLI provider switch, updates (draft)                            |
| [Coding workspace (v1.2.0)](features/coding-workspace.md)         | Three-column workspace, Changes · Files, full-screen review, context ring, images |
| [Dynamic Island](features/dynamic-island.md)                      | Notch-style notifications on macOS                                                |
| [Personalization](features/personalization.md)                    | Themes, app icons, shortcuts, language, accessibility                             |
| [Auto-update](features/auto-update.md)                            | Background check and confirm-to-install                                           |
| [Privacy & security](features/privacy-security.md)                | Data location, local-only mode, permission prompts, export                        |

### Development

- [Architecture](development/architecture.md)
- [Frontend engineering standards](development/frontend-standards.md)
- [Building](development/building.md)
- [Testing](development/testing.md)
- [CI triggers](development/ci.md)
- [Release](RELEASE.md): packaging, signing & notarization (incl. CI secret names)
- [Brand guidelines](BRAND.md): assets in [`brand/`](brand/), screenshots in [`screenshots/`](screenshots/)
