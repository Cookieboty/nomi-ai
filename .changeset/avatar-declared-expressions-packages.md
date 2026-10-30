---
'@nomi-ai/avatar-runtime': patch
'@nomi-ai/contract': patch
'@nomi-ai/core': patch
---

fix(character): 角色运行时判断 mapping 是不是 2.0.5 旧模板时带上包声明的表情（`AvatarMapping.set(mapping, expressions)`，`AvatarStage` 传 `character.capabilities.expressions`），与 validatePack 一致：声明了 `tears` 表情、把 `sad` 映射到它的自定义包不再被误判、整张映射被换成默认映射；没声明对应表情的 2.0.5 模板照旧回退。角色包快照（`character.getActivePack`）新增 `expressions`，覆盖包也把声明传给运行时（Node 与 Go 内核相同）。
