---
'@nomi-ai/contract': patch
'@nomi-ai/i18n': patch
---

fix(security): `harness.messageAgent` 标为 dangerous，且仅限对话窗口调用；补充命令审核会发送命令全文、以及没有系统沙箱时不会自动执行命令的文案。/ Mark harness.messageAgent as dangerous and chat-window-only, and add strings that command review sends the full command and that commands are not auto-run without an OS sandbox.
