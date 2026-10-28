# @nomi-ai/renderer — 看板娘渲染进程 / Mascot renderer

**中文：** 桌面看板娘窗口（React + Vite）。应用只内置 2D 看板娘 Nomi：默认用 Rive 播放动画，
Rive 起不来时回退到 Canvas2D 分层立绘（见 `public/assets/models/CREDITS.md`）。

**English:** Desktop mascot window (React + Vite). The app ships only the built-in 2D mascot **Nomi**:
animated with Rive by default, falling back to the Canvas2D layered rig if Rive cannot start
(see `public/assets/models/CREDITS.md`).

## 结构 / Structure

角色引擎（渲染后端、表情 / 动作驱动、命中区与互动、口型消费）在 [`@nomi-ai/avatar-runtime`](../avatar-runtime/README.md)；
这里只剩窗口壳与适配层。 / The character engine lives in `@nomi-ai/avatar-runtime`; this package is the window shell
plus a thin adapter.

- `src/components/Mascot/` — 宿主组件（气泡、工具栏、右键菜单、动作菜单、致谢等）；`Nomi2DCanvas.tsx` 等角色包就绪后挂 `AvatarStage`
- `src/avatar/` — 适配层：事件中枢 `avatarEvents`（`AvatarEventSource`）、契约窗口宿主（命中 / 拖拽 / 形状）、互动输出 → 气泡与朗读、当前角色 → `AvatarCharacter`
- `src/mascot/MascotDriver.tsx` — TTS 口型、主进程光标 / 物理事件、看板娘指令 → 语义事件
- `src/mascot/MascotAIBridge.tsx` — AI 事件（契约）→ 语义事件
- `src/mascot/characterConfig.ts` — 内置包 + Scheme B 覆盖包；`catalog.ts` 读取 `model-list.json`
- `src/mascot/tips.ts`、`characterCopy.ts`、`characterVoice.ts`、`tts/`、`voice/` — 台词、角色语音偏好、朗读与语音输入

## 素材 / Assets

只内置 Nomi，不提供角色切换、模型商店或导入。`pnpm check:licenses` 会拒绝没有开源许可（CC0 / CC-BY / MIT 等白名单）
或未登记在 `assets-licenses.json` 里的资源。

Only Nomi is bundled; there is no character switching, store or import. `pnpm check:licenses` rejects assets without an
allowlisted open license (CC0 / CC-BY / MIT, etc.) or missing from `assets-licenses.json`.

> 历史 / History：v1 曾使用第三方 2D 模型运行时与模型；因许可原因已整体移除。之后的 VRM 3D 渲染器也已移除。 / v1 used a third-party 2D model runtime and models; removed for licensing reasons. The later VRM 3D renderer has been removed as well.
