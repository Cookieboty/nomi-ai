---
'@nomi-ai/electron': minor
'@nomi-ai/ai-chat': minor
'@nomi-ai/ui': patch
---

使用官方账号登录后，可在输入栏直接切换模型与思考深度（Codex / Claude Code / Grok）：新增「模型」芯片（默认模型 / 目录内模型 / 自定义模型 id）与「思考深度」芯片（按各后端档位集渲染，仅推理模型显示）。设置按标签保存、下一条消息起生效，以进程级参数注入（codex `exec -c`、grok `-m` / `--reasoning-effort`、claude `--model` / `--effort`，Claude 长驻进程空闲时重启复用），不改写用户的全局 CLI 配置；非推理模型自动隐藏思考深度，第三方供应商档案激活时仍由档案管理模型。Gemini（ACP）/ dsh 暂无无头覆盖参数，不显示芯片。
