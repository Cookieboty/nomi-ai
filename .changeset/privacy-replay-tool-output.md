---
'@nomi-ai/desktop-go': patch
---

fix(privacy): 对话中途换模型时，之前工具读到的文件、命令输出、网页内容按新模型重新判断，不允许的换成占位后再发（#283）。撤销「始终允许」后，原标签下一轮不再带上这项沙箱授权（#282）。子任务面板里排队的消息只发给它自己的标签，按发送顺序送达（#281）。/ When you switch models mid-chat, file contents, command output and web pages that tools read earlier are checked again against the new model and replaced with a placeholder if it isn't allowed to see them (#283). Revoking an "always allow" sandbox grant now also takes it away from the tab that granted it, starting with its next turn (#282). Messages queued in the sub-task pane go only to their own tab, in the order you sent them (#281).
