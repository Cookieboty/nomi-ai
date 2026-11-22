---
'@nomi-ai/desktop-go': patch
---

为显式托管、已选项目的主对话接通实验性官方 Claude CLI factory，复用既有官方 stream-json driver、独立 native loop 与本机登录来源，不依赖 API provider。支持同一 worker 切回增量交接、显式原生只读权限响应和保守进程组停止；所有验收仅用假 CLI 子进程。冷 resume 未证明时不发送请求，明确 missing-session 才 full fallback；首用/权限 UI、Codex、完整恢复切换、API 工具对齐及 Windows 托管写入仍待完成，旧 API 路径不替换。
