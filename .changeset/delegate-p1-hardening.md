---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/bundle-ig-base': patch
---

委派 P1 加固：汇报字段包 untrusted 边界；`/agent` 钉住按会话+轮次隔离（失败中止发送）；拒绝委派标签再委派；git 改动列表用 rev-parse/porcelain -z；abort 后清理孤儿标签；`taken_over` 记为有意偏差；修复非 git 目录下 gitDiff 用例的竞态。
