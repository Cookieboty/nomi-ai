---
'@nomi-ai/ai-chat': minor
'@nomi-ai/i18n': patch
---

feat(chat): 会话详情加上「任务」列表（从这个会话建的持续任务及状态，包括派给后台 Nomi 的，点开到任务页；没有时不显示这一块）；智能体和任务都先显示 5 个，点「…」展开其余；窗口较窄时展开文件栏、Diff / 文件预览或子任务栏后会话详情自动收起，按钮仍可手动打开。子任务栏的输入栏里可以换模型和思考深度。/ Session details now lists this session's tasks with their status, including hand-offs to background Nomi (click to open on the tasks page; the block is hidden when empty); agents and tasks show five at first with a "…" button for the rest; on narrow windows the column hides itself while the files panel, diff / preview or sub-task pane is open, and the button can still bring it back. The sub-task pane's composer can switch the model and reasoning effort.
