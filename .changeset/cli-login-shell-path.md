---
'@nomi-ai/electron': patch
---

修复从 Dock / 开始菜单启动时找不到用 nvm、volta、fnm、asdf、mise、pnpm、bun 或自定义 npm prefix 安装的 Claude Code / Codex / dsh 等（#76）：
启动时读取登录 shell 的 PATH；安装 / 更新后到 npm 实际的全局 bin 目录查找并记住它；兜底目录补上常见的 Node 版本管理器；
nvm 等安装不再被误判为原生安装；对话里启动 CLI 时也带上补全后的 PATH，`#!/usr/bin/env node` 的 CLI 能找到 node。
