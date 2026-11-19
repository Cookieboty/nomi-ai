---
'@nomi-ai/ai-chat': minor
'@nomi-ai/i18n': minor
---

feat(chat): Agent 空会话在没选模型 / 没配置账号时给出就地引导。以前这种情况发消息只会撞报错，现在输入框上方会常驻一张卡片：只是还没选模型的，直接点「选择模型」在输入栏打开选择器（多供应商时直接列出全部供应商的模型）；连账号或供应商都没有的，点「去配置」跳到 Agents / 供应商设置。模型按钮在待选态显示「选择模型」，并跳过档位页直接列模型；发送与语音自动发送前都有守卫，未就绪时保留草稿并提示原因。新建 Agent 会话时如果当前那个还是从没用过的空标签，会先把它关掉再建，不再攒一排空标签。/ Empty Agent conversations now show an inline card instead of failing on the first message: one button opens the model picker right in the composer (listing every provider's models when several are configured), or jumps to the Agents / provider settings when no account or provider exists yet. The model button reads "Choose a model" and opens the model list straight away, sends (including voice auto-send) are gated with the draft kept, and creating an Agent conversation closes the previous never-used empty tab instead of piling them up.
