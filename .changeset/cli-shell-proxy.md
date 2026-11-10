---
'@nomi-ai/contract': patch
---

fix(cli): Codex 等编程助手登录报「device code request failed with status 403 Forbidden」——从 Finder / Dock 启动时 Nomi 拿不到终端配置（如 ~/.zshrc）里的 https_proxy，登录请求直连被官方服务按地区拒绝。现在读登录 shell 时一并读代理变量，加给编程助手的子进程（本机地址不走代理，网关不受影响），官方账号里新增「沿用终端里的代理」开关（默认打开）；登录被 403 拒绝时给出原因、检测到的代理和「沿用终端代理并重试」按钮。
