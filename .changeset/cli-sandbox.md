---
'@nomi-ai/desktop-go': minor
'@nomi-ai/ai-chat': minor
---

feat(security): macOS 上编程助手在系统沙箱里运行（默认开）：读不到 SSH 与 Git 凭据、云账号凭据、密钥库、浏览器数据、邮件 / 信息 / 照片等个人数据、`.env` 与私钥文件和受保护的文件夹，只能写项目文件夹、它自己的配置和缓存。被挡下时对话里出现卡片：本会话允许 / 始终允许 / 不允许，允许后编程助手自动重开并接着做，同一项不再重复问。「桌面权限 → 隐私保护」里可以开关沙箱、撤销「始终允许」。开着沙箱，就能放心让编程助手全部自动运行。/ On macOS coding agents now run in a system sandbox (on by default): they can't read SSH and Git credentials, cloud credentials, key stores, browser data, personal data like Mail, Messages or Photos, `.env` and private-key files, or protected folders, and can only write to the project folder and their own config and caches. When something is blocked a card in the chat offers Allow for this session / Always allow / Don't allow; once allowed the agent restarts and carries on, and the same item isn't asked again. Desktop permissions → Privacy turns the sandbox on or off and revokes "Always allow" entries. With the sandbox on, coding agents can safely run fully automatic.
