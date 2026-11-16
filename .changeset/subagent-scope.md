---
'@nomi-ai/ai-chat': patch
---

fix(subagent): 侧边聊天、打开的文件和预览标签按会话各记一份，编程助手新标签拿到会话 id 后从临时键平滑迁过去；子代理的图标按父消息实际的后端判断（流式中也对）；标签区铺满时收起会话详情。 Side chats, open files and preview tabs are kept per session and move over once a new coding-agent tab gets its session id; a sub-agent's icon follows the backend that actually produced its parent message (also while streaming); session details hide while the side tabs are maximized.
