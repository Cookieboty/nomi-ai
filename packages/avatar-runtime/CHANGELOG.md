# @nomi-ai/avatar-runtime

## 0.1.1

### Patch Changes

- 5e21cdb: fix(character): 角色运行时判断 mapping 是不是 2.0.5 旧模板时带上包声明的表情（`AvatarMapping.set(mapping, expressions)`，`AvatarStage` 传 `character.capabilities.expressions`），与 validatePack 一致：声明了 `tears` 表情、把 `sad` 映射到它的自定义包不再被误判、整张映射被换成默认映射；没声明对应表情的 2.0.5 模板照旧回退。角色包快照（`character.getActivePack`）新增 `expressions`，覆盖包也把声明传给运行时（Node 与 Go 内核相同）。
- 9adf768: feat(avatar-runtime): when Rive fails to start, `AvatarCanvas` shows the character's static image if it has one (`mascotRenderer` flag `static-fallback`), and only otherwise the layered sprite rig.
- b860434: fix(avatar): macOS 上关闭 Rive 动画后，静态立绘首次显示、重新打开「显示」或从 Rive 切回静态时不再是空白（之前要调整大小才出现）：先解码再画、画布布局好后再画，画出来是空的就自己重画（#303）。
- 9c50e18: fix(avatar): 桌面角色窗口从隐藏恢复时，静态立绘也重新画一遍并检查是否空白（窗口尺寸没变时之前不会重画）；同一帧里的多次重画请求合成一次。思路来自 #304。
- Updated dependencies [df95d1b]
- Updated dependencies [6dd7a97]
- Updated dependencies [be4a6cc]
  - @nomi-ai/character-contract@0.1.0
