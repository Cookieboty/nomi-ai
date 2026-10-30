---
'@nomi-ai/host-electron': patch
---

修复撤销 Nomi 对 dsh 的配置后 `~/.dsh/cordis.patch.yml` 被写成空文件、dsh 启动即退出的问题：没有其它内容时写入空数组 `[]`，再次接入时自动替换。
