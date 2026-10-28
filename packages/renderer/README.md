# @nomi-ai/renderer — 看板娘渲染进程 / Mascot renderer

**中文：** 桌面看板娘窗口（React + Vite）。应用只内置 2D 看板娘 Nomi：默认用 Rive 播放动画，
Rive 起不来时回退到 Canvas2D 分层立绘（见 `public/assets/models/CREDITS.md`）。

**English:** Desktop mascot window (React + Vite). The app ships only the built-in 2D mascot **Nomi**:
animated with Rive by default, falling back to the Canvas2D layered rig if Rive cannot start
(see `public/assets/models/CREDITS.md`).

## 结构 / Structure

- `src/mascot/MascotBackend.ts` — 渲染后端抽象（表情 / 口型 / 视线 / 眨眼）与 `mascotRegistry` / backend abstraction (expression / lip / gaze / blink) + `mascotRegistry`
- `src/mascot/backends/rive.ts`、`backends/sprite.ts` — Rive 与分层 2D 实现
- `src/mascot/catalog.ts` — 读取 `model-list.json`（每个模型必须有 `license` / `author` / `source`）
- `src/mascot/expressionDirector.ts` — 聊天 / Agent / 工具事件 → 表情（纯函数）
- `src/mascot/MascotDriver.tsx` — TTS 音量 → 口型、鼠标 → 视线
- `src/mascot/MascotAIBridge.tsx` — AI 事件 → 表情
- `src/mascot/tips.ts` — 原创提示文案（MIT）
- `src/components/Mascot/` — 宿主组件（气泡、工具栏、动作菜单、致谢等）

## 素材 / Assets

只内置 Nomi，不提供角色切换、模型商店或导入。`pnpm check:licenses` 会拒绝没有开源许可（CC0 / CC-BY / MIT 等白名单）
或未登记在 `assets-licenses.json` 里的资源。

Only Nomi is bundled; there is no character switching, store or import. `pnpm check:licenses` rejects assets without an
allowlisted open license (CC0 / CC-BY / MIT, etc.) or missing from `assets-licenses.json`.

> 历史 / History：v1 曾使用第三方 2D 模型运行时与模型；因许可原因已整体移除。之后的 VRM 3D 渲染器也已移除。 / v1 used a third-party 2D model runtime and models; removed for licensing reasons. The later VRM 3D renderer has been removed as well.
