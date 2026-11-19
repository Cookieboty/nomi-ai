---
'@nomi-ai/ai-chat': patch
---

feat(chat): 同协议原生的第三方模型默认沿用 CLI 自己的思考档位。以前 agent 标签选第三方模型时，Nomi 会把网关算出的「默认档」（如 medium）当成显式值塞进每一轮请求，Claude 跑中转 Claude、Codex 跑中转 GPT 这类同协议组合也跟着被改写，和官方模式下的行为不一致。现在认出模型天然所属的 CLI 家族（支持 `model.like`，中转改名的 `relay/my-opus` 也能认），未手动选档时一律透传，界面显示「默认」而不是「默认（medium）」；跨家族组合（Claude Code 跑 GPT、Codex 跑 Claude 等）保持原样，仍按模型默认档发送。手动选过的档位、以及选回默认都照旧即时同步到网关绑定。/ A third-party model that natively belongs to the running CLI (Claude on Claude, Codex on GPT, and relay-renamed models thanks to `model.like`) now inherits the CLI's own thinking level instead of being pinned to the gateway's default level each turn, matching official-mode behaviour; the picker shows "Default" rather than "Default (medium)". Cross-family combinations keep the previous behaviour, and explicitly picked levels still sync to the gateway binding immediately.
