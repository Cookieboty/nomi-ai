---
'@nomi-ai/contract': patch
'@nomi-ai/ai-chat': patch
---

fix(projects): `project.remove` 的输出从 `null` 改成无返回值，并给设置里的「删除项目」加上进行中保护。以前删除后按钮仍可再点，第二次必然以 `PROJECT_NOT_FOUND` 报错、弹一条吓人的红字；现在移除期间按钮置灰、请求进行中不再受理第二次点击。Go 侧同步补了契约输出与二次删除的用例。/ `project.remove` now declares no output instead of `null`, and the project dialog disables its delete button while the removal is in flight, so an impatient second click can no longer surface a raw `PROJECT_NOT_FOUND` error.
