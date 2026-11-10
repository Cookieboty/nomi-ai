---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(agent): `/agent 名字 需求` 直接派出编程助手，派不出去时说明原因，不再由对话模型回一句当作已经交出。`NOMI_USE_MOCK_CLI=1` 从 `apps/desktop-go` 启动也能找到仓库里的假 CLI；假 CLI 不提供更新到正式版。新建任务的代码目录菜单不再被对话框挡住，新建任务默认改为手动运行。 / `/agent name request` starts the coding assistant directly, and a failed handoff is explained instead of a normal reply that looks like success. `NOMI_USE_MOCK_CLI=1` finds the repo mocks when the app starts from `apps/desktop-go`. Mock CLIs are not offered an update to a real release. The code-folder menu in a new task is no longer hidden behind the dialog, and a new task defaults to run manually.
