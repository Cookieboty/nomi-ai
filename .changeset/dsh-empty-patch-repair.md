---
'@nomi-ai/desktop-go': patch
---

修复 dsh 启动即退出（`patches … must be a top-level YAML array`）：旧版本移除 Nomi 配置后会留下空的 `~/.dsh/cordis.patch.yml`，之后不会再被改写。现在启动 dsh 前检查一次，只剩空白 / 注释时补成空数组（原有注释保留）。Node 版与 Go 版一致。
