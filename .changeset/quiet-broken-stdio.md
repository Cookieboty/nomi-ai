---
'@nomi-ai/electron': patch
---

修复从终端启动后关掉终端（如 Ctrl+C 结束 `pnpm dev`）时弹出「应用遇到了严重错误：write EIO」：控制台已断开时的日志输出失败直接忽略，日志照常写入文件。
