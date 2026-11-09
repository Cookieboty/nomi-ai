---
'@nomi-ai/desktop-go': minor
'@nomi-ai/ai-chat': minor
'@nomi-ai/contract': minor
---

工作区改为「项目」：一个项目可以包含多个文件夹（跨端工程的前端、后端、文档放在一起），其中一个是主文件夹（工作目录、git、AGENTS.md 以它为准），其余文件夹 Nomi 和编程助手同样能读写（Claude Code / Codex `--add-dir`、Gemini `--include-directories`、ACP `additionalDirectories`，系统沙箱一并放行）。侧栏「项目」标题上的按钮打开「创建项目」（不再直接开对话），项目上的「…」可以改名、增删文件夹、换主文件夹或移除。会话只记项目，改了项目的文件夹下一轮起生效。右栏「改动」每个 git 仓库一段（各自的分支、暂存与提交），「文件」每个文件夹一个顶层节点，`@` 路径补全覆盖所有文件夹。首次启动时以前用过的每个工作目录各建成一个项目。

Workspaces are now projects: a project can hold several folders (frontend, backend and docs of one product together). One is the primary folder (working directory, git and AGENTS.md come from it); Nomi and coding agents can read and write the others too (Claude Code / Codex `--add-dir`, Gemini `--include-directories`, ACP `additionalDirectories`, and the system sandbox allows them). The button on the sidebar's Projects header opens "Create project" instead of starting a chat, and a project's "…" menu renames it, adds or removes folders, changes the primary folder, or removes the project. Chats only reference their project, so folder changes apply from the next turn. In the side panel, Changes shows one section per git repository (each with its own branch, staging and commit), Files shows one top-level node per folder, and `@` path completion covers every folder. On first launch each previously used working directory becomes a project.
