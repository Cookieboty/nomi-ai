# @nomi-ai/avatar-runtime

角色引擎（纯浏览器）：Rive / sprite（分层 2D 骨架）/ static 渲染后端、表情与动作驱动、命中区与互动反应、口型消费。
不依赖 `contract`、`electron`、`ai-sdk-client`、`ui` 或任何视图包（eslint 与 `tests/boundary.test.ts` 双重把关）；
AI 与宿主能力全部经注入的接口接入。设计见 [docs/design/core-host-decoupling.md](../../docs/design/core-host-decoupling.md) §10.5、§10.6。

## 输入 / 输出

| 方向 | 接口                                    | 内容                                                                                                         |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 输入 | `character: AvatarCharacter`            | manifest 的引擎字段（`mode`、`assets`、`rive`、`layout` 命中区、`capabilities`）+ `mapping`（C3 才按它翻译） |
| 输入 | `resolveAsset(path) → url`              | 包内相对路径 → URL；已经是 URL 的路径原样使用                                                                |
| 输入 | `events: AvatarEventSource`             | 语义事件：`speaking`（口型包络）、`cue`、`reply`、`emotion`、`gesture`、`voice`、`cursor`、`physics`         |
| 输出 | `onInteraction(AvatarInteractionEvent)` | 互动反应：`click` / `double` / `pat` / `hover` / `grab` / `land` / `wall`，带区域与台词 key、是否朗读        |
| 输出 | `windowHost?: AvatarWindowHost`         | 透明桌面窗口（可选）：命中（点击穿透）、拖拽、身体框、Linux 窗口形状                                         |
| 其它 | `riveWasmUrl`、`onMark`、`debugHandles` | 宿主打包的 Rive wasm；就绪打点（`mascot-model-loaded` 等）；开发态把后端挂到 `globalThis.__nomiMascot`       |

```tsx
import { AvatarStage, createAvatarEventHub } from '@nomi-ai/avatar-runtime';

const events = createAvatarEventHub();
<AvatarStage
  character={character}
  resolveAsset={(p) => `./character/${p}`}
  events={events}
  onInteraction={(e) => showBubble(e.line)}
/>;
events.emit({ type: 'emotion', name: 'happy' });
```

不用 React 的宿主用 `mountAvatar(element, options)`，`dispose()` 释放全部资源（后端、wasm 实例、图片、计时器、订阅）。

## 独立运行

```bash
pnpm --filter @nomi-ai/avatar-runtime demo                                  # characters/test-dummy
AVATAR_DEMO_PACK=characters/nomi pnpm --filter @nomi-ai/avatar-runtime demo # 官方包（Rive）
```

`demo/` 是一个 Vite 开发页：假的事件源（按钮、口型正弦波）+ 互动输出日志，没有窗口宿主（不拖窗口、不点击穿透）。
`tests/runtime.test.tsx` 在 happy-dom 里用替身角色包与假事件源挂载运行时。

## 结构

| 路径                                                                 | 内容                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/AvatarStage.tsx`、`src/mount.ts`                                | 入口：React 组件 / 命令式挂载                                                               |
| `src/host.ts`、`src/events.ts`                                       | 输入输出接口、`createAvatarEventHub`、`avatarCharacterFromPack`                             |
| `src/driver.ts`                                                      | 语义事件 → 当前后端（口型、说话姿态、表情导演、流式情绪）                                   |
| `src/canvas/`                                                        | 按 `mode` 选画布（Rive 失败回退分层 2D）、三种画布、`InteractionLite`                       |
| `src/MascotBackend.ts`、`src/backends/`                              | 后端抽象与全局注册表、Rive / sprite / static 实现                                           |
| `src/expressionDirector.ts`、`emotion.ts`、`mood.ts`、`voiceMood.ts` | 事件 / 文本 → 表情与动作，自动动作冷却                                                      |
| `src/layeredRig.ts`、`src/rig/`、`src/motion/`                       | 分层 2D 骨架、43 个命名动作与显示名 key                                                     |
| `src/interaction/`、`spriteInteraction.ts`、`layoutStore.ts`         | 命中区、手势、互动反应、互动设置（经 `setInteractionConfigBackend` 推给宿主）、布局共享状态 |
