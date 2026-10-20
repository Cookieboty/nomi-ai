---
'@nomi-ai/ui': patch
---

使用官方账号登录后，可在输入栏直接切换模型与思考深度（Codex / Claude Code / Grok）：新增一枚「模型 · 思考深度」按钮（参考 Codex：浮层大字显示当前档位，下方「模型名 ›」进入模型列表，可选默认模型 / CLI 列出的模型 / 自定义模型 id，再下方用分档滑杆调思考深度）。模型列表、每个模型支持的档位与默认档位全部从 CLI 自己读取、不写死：Claude Code 读 stream-json `initialize` 的模型列表（与 `/model` 一致），Codex 读 `codex debug models` 与 config.toml 的默认模型 / 档位，Grok 读 `grok agent stdio`（ACP）的模型列表；切换账号或供应商后重新读取，读不到时只保留默认模型与自定义 id。设置按标签保存、下一条消息起生效，以进程级参数注入（codex `exec -c`、grok `-m` / `--reasoning-effort`、claude `--model` / `--effort`，Claude 长驻进程空闲时重启复用），不改写用户的全局 CLI 配置；非推理模型自动隐藏思考深度，第三方供应商激活时仍由供应商管理模型（按钮隐藏，标签覆盖也不再注入）；Claude 有后台任务时切换不会中断它们，等后台结束后的下一条消息再生效。Gemini（ACP）/ dsh 暂无无头覆盖参数，不显示按钮。
