---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

fix(security): 编程助手的本机保护：工作目录只能是项目文件夹（根目录、主目录、文稿 / 桌面这类大文件夹、系统目录、敏感目录和受保护的文件夹都不行），选目录、新建标签、每次启动 CLI 前都检查；编程助手和 Nomi 的工作区命令不再继承环境里的令牌、密码、云账号密钥和数据库连接串（模型服务的凭据照常传）；Codex 默认不联网，「自动改文件」下要联网或写工作区外时先发确认。「桌面权限」新增「隐私保护」页：自己加受保护的文件夹、放行确实需要的环境变量；「编程助手 → 权限」新增「允许 Codex 联网」开关。/ Local protection for coding agents: the working folder must be a project folder (not the root, home, large folders like Documents or Desktop, system folders, sensitive folders or protected folders), checked when picking a folder, opening a tab and before every CLI launch; coding agents and Nomi's workspace commands no longer inherit tokens, passwords, cloud keys or database URLs from your environment (model API keys still pass through); Codex is offline by default and, in Accept edits, asks before going online or writing outside the workspace. Desktop permissions gains a Privacy page to add your own protected folders and allow environment variables you really need; Coding agents → Permissions gains "Let Codex use the network".
