---
'@nomi-ai/contract': patch
---

fix(contract): `project.remove` 的输出改为无返回值（以前声明 `null`），Go 侧同步补了契约输出与二次删除的用例。/ `project.remove` now declares no output instead of `null`; the Go side gains contract-output and double-remove tests.
