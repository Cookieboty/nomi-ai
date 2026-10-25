---
'@nomi-ai/gateway': patch
---

第三方模型按「模型规格」适配：网关内置一份离线的模型能力表（来自 models.dev，MIT），跨协议时思考强度按模型实际支持的档位发送（例如请求 xhigh、模型最高只到 high 就发 high，并在请求记录里注明）；Claude 4.6 一类模型发 adaptive 思考，DeepSeek / Kimi / GLM 等需要回传推理的模型自动带回历史推理；GPT-5 等推理模型在 Chat 接口上自动去掉不接受的 temperature、把 max_tokens 改成 max_completion_tokens；Gemini 表达不了的工具 schema 改用 parametersJsonSchema。上游因思考预算或档位不合法拒绝时自动修正后重试一次，并记住这个模型可用的档位。新增严格模式开关（默认关）：打开后不支持的参数直接报错而不是静默去掉。
