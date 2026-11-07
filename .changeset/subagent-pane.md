---
'@nomi-ai/desktop-go': minor
'@nomi-ai/ai-chat': minor
---

feat(delegate): 子任务在对话旁边单独一栏打开（不再弹窗），可以接着和它对话：运行中发送会插话给它，「停止」打断这一轮，空闲时发送就接着再做一轮；之后每一轮的结果（包括沙箱授权后自动接着做的）都会回到主对话，Nomi 下一轮能读到。空闲时在子任务里发消息不再算「接手」，Nomi 还能接着往这个子任务里派活。/ Sub-tasks now open in their own column beside the chat (no more pop-up) and you can keep talking to them: sending while running interjects, Stop interrupts the turn, and sending when idle runs another turn; every later turn's result (including the automatic continue after a sandbox grant) comes back to the main chat for Nomi to read. Messaging an idle sub-task no longer counts as taking it over, so Nomi can keep sending work to it.
