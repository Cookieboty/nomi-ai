---
---

fix(cli): 在大小写敏感的宿主上按磁盘真实名字解析 Windows 启动器

PATHEXT 常写成大写（`.COM;.EXE;.BAT;.CMD`），而 npm 生成的 shim 是小写的 `reclaude.cmd`。
以前按 PATHEXT 原样拼出的 `reclaude.CMD` 在大小写敏感的宿主上并不存在，登录检测与用量查询就解析不到
对话里用的同一个 CLI。现在 Windows 平台先按目录里的真实名字折叠再判断，且只在大小写不同、映射唯一时算命中，
不会把不存在的文件当成存在；POSIX 平台保持大小写敏感。
