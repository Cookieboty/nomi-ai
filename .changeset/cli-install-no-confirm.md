---
'@nomi-ai/ai-chat': patch
---

fix(cli-install): 安装 / 更新编程助手不再二次确认：前置检查通过就直接执行，成功后日志和结果自动收起；只有缺 Node.js、没有写入权限这类装不了的情况才弹框说明。/ Installing or updating a coding assistant no longer asks for confirmation: if the checks pass it runs right away, and on success the log and result close by themselves. A dialog appears only when something blocks the install, such as a missing Node.js or no write permission.
