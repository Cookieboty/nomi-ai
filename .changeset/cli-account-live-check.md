---
'@nomi-ai/electron': patch
---

删除官方账号前会检查终端里是否还有 CLI 在用这个账号目录（Claude 读会话文件里的进程号，Codex / Grok / Gemini 看目录里被打开的文件），有就拒绝删除并显示进程号，避免删掉正在用的登录；检测不了时（如 Windows 上的 Codex / Grok / Gemini）照常经确认后删除。Codex 账号改用官方 `codex app-server` 的 `account/read` 读出邮箱与套餐，历史会话能按 Codex 记录的账号 id 标出账号；Nomi 仍不读取任何凭据文件。
