# Nomi 文档 / Nomi Docs

<p align="left"><a href="#中文">中文</a> · <a href="#english">English</a></p>

---

## 中文

Nomi·诺米：让每一种 AI 能力，都为你所用。把 Claude Code、Codex 放到同一张看板上并行。模型只接一次，官方、国内、中转或本地都能用。不必绑定云账号，也不用改那些 CLI 的全局配置。
桌面应用（Go + Wails，`apps/desktop-go`）。Nomi 自己也是一个 agent，桌面角色可选。界面是 React（`packages/`）。

### 开始

- [快速上手](getting-started.md)：安装、首次引导、开编程助手会话、添加模型、常用快捷键

### Agent 工作台

| 模块                                       | 说明                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| [编程助手](features/coding-agents.md)      | Claude Code / Codex / Gemini CLI / Grok / dsh：账号与第三方供应商、权限模式、工坊、会话 |
| [Agent 看板](development/agent-board.md)   | 谁在干活、做到哪了、内存与 CPU；内存守护自动暂停 / 恢复                                 |
| [编程助手监视](features/agent-monitor.md)  | 本机编程工具的进度提醒                                                                  |
| [斜杠命令](features/slash-commands.md)     | 输入 `/` 弹出命令，内置命令在界面里执行，其余转给 CLI                                   |
| [隐私与安全](features/privacy-security.md) | 数据位置、仅本地模式、外发保护、权限确认、导出与清除                                    |

### 模型与工具

| 模块                                        | 说明                                                         |
| ------------------------------------------- | ------------------------------------------------------------ |
| [第三方供应商与模型](features/providers.md) | 切换模型、添加 / 从网页添加供应商、按任务分配、多 Key 与回退 |
| [本地模型](features/local-models.md)        | 一键运行开源小模型、Ollama、离线模式                         |
| [MCP 与技能](features/mcp-skills.md)        | MCP 服务器、SKILL.md 技能、从其他工具导入                    |
| [自动化与桌面能力](features/automation.md)  | 文件、命令、提醒与剪贴板、代码沙箱、工具权限、操作记录       |

### Nomi

| 模块                                          | 说明                                                             |
| --------------------------------------------- | ---------------------------------------------------------------- |
| [AI 对话](features/chat.md)                   | 灵伴与工坊、图片与文件、生成图片与素材库、命令面板、交给编程助手 |
| [知识库](features/knowledge-base.md)          | 基于你的文件夹回答，并给出引用                                   |
| [长期记忆](features/memory.md)                | Nomi 记得什么、怎么想起、怎么管理                                |
| [日程与任务](features/scheduling-calendar.md) | 提醒、定时任务、主动聊天、免打扰、持续任务、应用与账号           |
| [桌面角色诺米](features/mascot.md)            | 可选，可随时关掉：动作、显示方式、工具栏、大小与互动设置         |
| [语音](features/voice.md)                     | 语音输入、唤醒词、诺米的声音                                     |
| [灵动岛通知](features/dynamic-island.md)      | macOS 刘海处的通知                                               |

### 应用

| 模块                                  | 说明                                       |
| ------------------------------------- | ------------------------------------------ |
| [个性化](features/personalization.md) | 主题、应用图标、侧栏、快捷键、语言、无障碍 |
| [自动更新](features/auto-update.md)   | 后台下载，确认后原地安装并重启             |

### 角色包与接入

- [角色包](character-pack/README.md)：做一个自己的角色（[契约](character-pack/CONTRACT.md)、[替换官方角色](character-pack/REPLACING.md)、[设计师清单](character-pack/designer-checklist.md)）
- [第三方供应商链接接入](integrations/provider-link.md)：中转站 / 模型平台的「添加到 Nomi」按钮（`nomi://provider/*`）

### 开发

- [架构概览](development/architecture.md)
- [应用契约](development/contract.md)：视图与内核之间的过程、事件与传输，怎么加一个过程
- [统一网关](development/gateway.md)：四种协议互转、路由、供应商与模型
- [编程助手接入](development/coding-agents.md)：插件、会话驱动、编排器、权限档位
- [Agent 看板](development/agent-board.md)：纳管与外部的边界、分列、内存与 CPU 采样
- [安全边界](development/security.md)：路径授权、命令审核、代码沙箱、委派隔离、网络与密钥
- [构建与运行](development/building.md) · [测试](development/testing.md) · [CI](development/ci.md)
- [多语言](development/i18n.md) · [前端工程规范](development/frontend-standards.md) · [Git LFS](development/git-lfs.md)
- [发布](RELEASE.md)：打包、签名、更新清单与 Release
- [品牌规范](BRAND.md)：素材在 [`brand/`](brand/)（Rive 场景见 [rive-complete](brand/rive-complete.md)），截图在 [`screenshots/`](screenshots/)
- 各版本更新说明：[`releases/`](releases/)

---

## English

Nomi: One place. Every AI capability. Run Claude Code and Codex in parallel on one board. Connect a model once — official APIs, China-region, relays, or local. No Nomi cloud account. No edits to those CLIs' global config.
Desktop app (Go on Wails, `apps/desktop-go`). Nomi is an agent too, and the desktop character is optional. The UI is React (`packages/`). The pages below are written in Chinese.

### Getting started

- [Getting started](getting-started.md): install, onboarding, open a coding-agent session, add a model, shortcuts

### Agent workbench

| Module                                             | About                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Coding agents](features/coding-agents.md)         | Claude Code / Codex / Gemini CLI / Grok / dsh: accounts, providers, permission modes, workbench |
| [Agent board](development/agent-board.md)          | Who is working, how far along, memory and CPU; the memory guard pauses and resumes              |
| [Coding-agent monitor](features/agent-monitor.md)  | Progress notices for local coding tools                                                         |
| [Slash commands](features/slash-commands.md)       | `/` palette; built-ins run in the UI, the rest go to the CLI                                    |
| [Privacy & security](features/privacy-security.md) | Data location, local-only mode, outbound masking, prompts, export                               |

### Models & tools

| Module                                      | About                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| [Providers & models](features/providers.md) | Switch models, add providers (also from web links), per-task models, multi-key |
| [Local models](features/local-models.md)    | One-click small models, Ollama, offline mode                                   |
| [MCP & skills](features/mcp-skills.md)      | MCP servers, SKILL.md packs, importing from other tools                        |
| [Automation](features/automation.md)        | Files, commands, reminders, clipboard, code sandbox, tool permissions          |

### Nomi

| Module                                              | About                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| [AI chat](features/chat.md)                         | Assistant and workbench, images and files, image generation, command palette |
| [Knowledge base](features/knowledge-base.md)        | Answers from your folders, with citations                                    |
| [Long-term memory](features/memory.md)              | What Nomi remembers and how to manage it                                     |
| [Schedule & tasks](features/scheduling-calendar.md) | Reminders, jobs, proactive chat, DND, persistent tasks, apps & accounts      |
| [Desktop character](features/mascot.md)             | Optional, close it any time: actions, display modes, toolbar, size, settings |
| [Voice](features/voice.md)                          | Speech input, wake word, the character's voice                               |
| [Dynamic Island](features/dynamic-island.md)        | Notch-style notices on macOS                                                 |

### App

| Module                                         | About                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| [Personalization](features/personalization.md) | Themes, app icons, sidebar, shortcuts, language, accessibility         |
| [Auto-update](features/auto-update.md)         | Background download; installs in place and relaunches when you confirm |

### Character packs & integrations

- [Character packs](character-pack/README.md) ([contract](character-pack/CONTRACT.md), [replacing the official character](character-pack/REPLACING.md), [designer checklist](character-pack/designer-checklist.md))
- [Provider links](integrations/provider-link.md): the "Add to Nomi" button for relays and model platforms (`nomi://provider/*`)

### Development

- [Architecture](development/architecture.md) · [App contract](development/contract.md) · [Unified gateway](development/gateway.md)
- [Coding-agent integration](development/coding-agents.md) · [Agent board](development/agent-board.md) · [Security boundaries](development/security.md)
- [Building](development/building.md) · [Testing](development/testing.md) · [CI](development/ci.md)
- [i18n](development/i18n.md) · [Frontend standards](development/frontend-standards.md) · [Git LFS](development/git-lfs.md)
- [Release](RELEASE.md) · [Brand](BRAND.md) · [Release notes](releases/)
