---
'@nomi-ai/electron': minor
'@nomi-ai/ai-chat': minor
---

打开 CLI 历史会话时沿用它实际使用的模型、思考深度与权限档位（Claude Code / Codex / Gemini / dsh，新增 Grok 历史）；权限菜单按 CLI 声明的模式列出，模型按钮直接显示 CLI 的默认档位。历史未记录权限时，Gemini / Grok 首次握手采用 CLI 当前模式（完全放开仍需确认）；用户先手动选档或切换后端后不再被覆盖，CLI 返回未知模式时按标签档位显式切换而不会卡住标签。Codex 历史按 sandbox + approval 还原档位；列表阶段不再整份解压过大的 dsh 会话；兼容带 BOM 的 jsonl 日志。
