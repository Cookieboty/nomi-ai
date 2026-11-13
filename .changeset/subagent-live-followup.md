---
'@nomi-ai/desktop-go': minor
'@nomi-ai/ai-chat': minor
---

feat(chat): 子任务侧栏里的后台 Nomi 和进程内子代理实时更新，也能接着说话：后台 Nomi 的正文、思考和工具步骤按事件实时推到侧栏（不再每 1.5 秒拉一次）；运行中 Enter 插话给它（下一步生效），Ctrl+Enter 排队到这次跑完，空闲时发送就是追问，带着上次的结果再跑一次，结果照常回到主对话。Claude Code 子代理自己说的话进侧栏（不再混进主回复），在侧栏里发的话经来源标签交给主代理转给这个子代理。侧栏输入栏的设置、插件、模型、扩展等按钮和斜杠命令打开主窗口的面板。/ Background Nomi and in-process subagents in the sub-task side panel now update live and accept follow-ups: background Nomi's text, thinking and tool steps are pushed to the panel as events (no more 1.5 s polling); while it runs, Enter interjects (applied at the next step) and Ctrl+Enter queues until the run ends, and sending when idle is a follow-up that reruns the task from the last result, with the result going back to the main chat as usual. Claude Code subagents' own messages show in the panel (no longer mixed into the main reply), and messages sent there go through the source tab to the main agent, which passes them to that subagent. The settings, plugins, models and extensions buttons and slash commands in the panel composer open the main window's panels.
