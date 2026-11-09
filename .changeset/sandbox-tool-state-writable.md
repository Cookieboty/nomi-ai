---
'@nomi-ai/desktop-go': patch
---

沙箱不再为工具写日志、缓存弹授权请求：主目录下的隐藏目录、`~/.config`、`~/Library/Application Support` 默认可写（比如钩子脚本写 `~/.ai-usage`）。凭据目录写之前照样要授权；shell 配置、开机自启、PATH 里的可执行目录、CLI 与编辑器的钩子和 MCP 配置照样不让改，也不再弹请求。
