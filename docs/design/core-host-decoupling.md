# 内核、宿主、视图、角色四分离（设计稿）

> 状态：**已实施**（§12 表中 P0–P4、C1–C3 全部完成，随 2.0.5 发布）。起草 2026-10-28。
> 已定（2026-10-28）：角色文案跟着角色包走（§10.2）；契约层自研（§4.4）；项目没有 Live2D，`live2d` 命名与死代码直接删除，不保留别名（§10.5）。
> 查证：§2 是起草当天基于 `release/2.0.5` 的统计；附录 A 保留起草时的快照，并附实施后在新路径上重新测得的数字。
> 相关：[架构](../development/architecture.md)、[角色包契约](../character-pack/CONTRACT.md)、[编程助手插件化](cli-plugin-architecture.md)、[统一模型网关](unified-gateway.md)。

## 0. 一句话

把应用拆成四块，每块可以单独重写、单独替换：

- **内核（core）**：纯 Node 的业务逻辑，不认识 Electron，不认识窗口，不认识任何角色；
- **宿主（host）**：Electron（以后可能是 Tauri、无界面 Node），只提供平台能力和窗口；
- **视图（views）**：对话窗口、看板娘窗口、设计系统，只通过**契约**和内核说话；
- **角色（character）**：纯数据的角色包，由视图侧的角色运行时和内核侧的人设服务读取。

依赖方向只有一条：**视图 → 契约 ← 内核 → 端口 ← 宿主**。视图和内核互不 import，宿主可以整体替换，角色包不含代码。

## 1. 目标与非目标

### 1.1 目标

| #   | 目标                               | 验收方式（§11）                                    |
| --- | ---------------------------------- | -------------------------------------------------- |
| G1  | 内核不依赖 Electron                | lint 禁止 import；无界面宿主跑通现有 `e2e/`        |
| G2  | 视图不依赖宿主                     | 视图只用契约 client；开发态视图能在普通浏览器运行  |
| G3  | 视图与内核可以各自迭代、各自重构   | 只要契约版本兼容，任一侧改动不需要动另一侧         |
| G4  | 宿主可替换                         | 新宿主 = 实现端口 + 一个传输适配，不改内核和视图   |
| G5  | 角色可替换，且换角色不残留官方人设 | 替身角色包跑 e2e，界面与系统提示中不出现官方角色名 |
| G6  | 解耦以后不回退                     | 边界规则全部进 CI，设为 error                      |

### 1.2 非目标

- **本稿不换宿主**。Electron 仍是唯一的生产宿主；本稿只保证「能换」。
- **不做运行时多角色切换、角色商店**。契约留好位置，等产品有需求再做（§10.7）。
- **不强行抽象平台特有的窗口能力**。透明浮窗、点击穿透、托盘、灵动岛留在宿主里，按能力声明降级（§9）。
- **不重写业务**。迁移以搬目录、插接口、机械替换为主（§12）。

## 2. 现状（代码事实）

### 2.1 主进程：业务大多不依赖 Electron，但放在 electron 包里

`packages/electron/src` 下各模块的代码量与 `import … from 'electron'` 的文件数：

| 模块                                                    | 代码行  | import electron 的文件 |
| ------------------------------------------------------- | ------- | ---------------------- |
| `cli/`                                                  | ~17,750 | 7                      |
| `usage/`                                                | ~10,240 | 2                      |
| `gateway/`                                              | ~4,910  | 0                      |
| `desktop/`                                              | ~4,080  | 1                      |
| `voice/` `extensions/` `agents/` `knowledge/` `memory/` | 各 1–3k | 各 1                   |
| `core/`（窗口、托盘、启动）                             | ~3,240  | 6                      |

所以业务和 Electron 的耦合不在业务逻辑本身，而是集中在**四个口子**：

| 口子         | 规模                                                                        | 说明                                     |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------------- |
| ① 事件广播   | 29 个文件调用 `BrowserWindow.getAllWindows()` / `webContents.send`          | 最主要的耦合，业务服务直接认识「窗口」   |
| ② 平台能力   | `app.getPath` 10 个文件、`safeStorage` 9 个、`dialog/shell/clipboard` 15 个 | 路径、密钥、系统对话框、外链             |
| ③ 通信层     | 两套桥（§2.2）                                                              | 一套有类型、一套无类型                   |
| ④ 窗口与托盘 | `core/WindowManager`、`TrayManager`、`mascot/`、`island/`                   | 本来就属于宿主，这部分保留在宿主里（§9） |

完整文件清单见附录 A。

### 2.2 渲染进程：两套桥

| 桥                   | 形态                                                                                                                      | 问题                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `window.aiIPC`       | `IPCBridge` 接口 + `IPC_METHODS` 规格表（起草时 37 个方法，删除 `setParameter` 后 35 个；`ai:<facade>:<method>`），有类型 | 规格表在 `ai-runtime/src/channels.ts` 和 `ai-sdk-client/src/channels.ts` 各一份，靠快照测试防止两边不一致 |
| `window.electronAPI` | preload 直接暴露的对象，无类型约束                                                                                        | 视图里 21 个文件直接调用（files、updates、island、voice 设置、诊断……）                                    |

### 2.3 已经有的样板：ai 域

`packages/ai-runtime` 已经按「端口 + 适配器」做过一遍，可以直接作为全应用推广的模板：

- `IpcAdapter`：对 `ipcMain` / `webContents` 的最小抽象，测试里注入 fake；
- `EventBroadcaster`：把内核事件桥接到窗口，支持按窗口订阅子集；
- `AppLifecycle` + `NoopLifecycle`：生命周期端口；
- `IPCBridge`（渲染侧）：注释里已经写明预留了 WebWorker / postMessage 实现。

美中不足：Electron 适配器（`createElectronIpcAdapter`、`createElectronLifecycle`）放在 ai-runtime 里，靠 `nodeRequire('electron')` 延迟加载，所以静态 grep 统计不到，但包本身仍然认识 Electron。本稿把这些适配器移到宿主包（§6.3）。

### 2.4 角色：有契约，但资产、引擎和人设仍嵌在产品里

| 问题                       | 位置                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 官方资产散在三处，原地覆盖 | `renderer/public/assets/models/…`、`renderer/public/voice/nomi`、`ai-chat/src/components/Onboarding/art`                                                                       |
| 身份配置有两份             | `renderer/src/mascot/character.generated.json`、`bundle-ig-mascot/src/character.generated.json`                                                                                |
| 人设有两条硬编码兜底       | `bundle-ig-mascot/src/plugins/WaifuAgentPresetPlugin.ts` 写死「你是 Nomi（诺米）……」；`ai-chat/src/services/IPCClient.ts` 用 i18n key `you-are-nomi-an-ai-companion-who-lives` |
| 角色引擎和窗口壳在同一个包 | `renderer/src/mascot`（引擎、情绪、命中区、口型）与气泡、工具栏、右键菜单、`src/ai` 桥同在 `packages/renderer`                                                                 |
| AI 知道动作名              | 工具 `live2d_play_motion` / `live2d_set_expression`；preset 名 `waifu`                                                                                                         |
| 产品品牌与角色名混在一起   | `electron/src/brand.ts` 的 `APP_DISPLAY_NAME_ZH = 'Nomi·诺米'`；`Nomi` / `诺米` 出现在 ai-chat 87 个文件、electron 71 个、renderer 20 个，大多数指产品而不是角色               |

后果：换皮能换立绘和语音，但对话人设可能仍是官方 Nomi；换一个角色要改 UI 包里的文件。

## 3. 目标架构

### 3.1 分层

```
 视图层（可独立重写）
 ai-chat · renderer（窗口壳） · @nomi-ai/avatar-runtime · @nomi-ai/ui
        │ 只依赖 ↓
 ┌──────▼──────────────────────────────────────────────────────┐
 │ @nomi-ai/contract   API 契约（唯一来源）                      │
 │ procedures + events + zod schema + 版本号                     │
 │ 生成：类型化 client（视图用）/ router 骨架（内核实现）         │
 └──────▲───────────────────────────────────▲──────────────────┘
        │ Transport 接口                     │ implement
 ┌──────┴───────────────┐        ┌───────────┴──────────────────────┐
 │ 传输适配（可替换）      │        │ @nomi-ai/core  应用内核（纯 Node）  │
 │ · Electron IPC        │◄──────►│ cli · usage · gateway · memory      │
 │ · WebSocket           │        │ knowledge · schedule · persona …    │
 │ · in-process（测试）  │        │ 只依赖 ↓ 端口                        │
 └──────────────────────┘        └───────────┬──────────────────────┘
                                             │
                                 ┌───────────▼──────────────────────┐
                                 │ @nomi-ai/host-ports  端口定义      │
                                 │ Paths · Secrets · Dialogs · Shell  │
                                 │ Clipboard · ScreenCapture · Power  │
                                 │ Lifecycle · Windows（声明式）      │
                                 └───────────▲──────────────────────┘
                                             │ implement
               ┌─────────────────────────────┼──────────────────────────┐
         host-electron                  host-node                   以后的宿主
         窗口 · 托盘 · preload          无界面，测试 / 开发          Tauri sidecar 等
         协议 · 浮窗物理

 角色包（纯数据）characters/<id>  ── 经 @nomi-ai/character-contract 校验后
                                     被 avatar-runtime（视图）与 PersonaService（内核）读取
```

### 3.2 依赖规则

| 包                        | 可以依赖                                                                                                                                                                                                                                                                                      | 不得依赖                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `contract`                | `zod`、`types`                                                                                                                                                                                                                                                                                | 任何运行时包                                                                                                     |
| `host-ports`              | `types`                                                                                                                                                                                                                                                                                       | 任何运行时包                                                                                                     |
| `core`                    | `contract`、`host-ports`、`gateway`、`cli-sdk`、`ai-runtime`（去掉 Electron 适配器后）、`character-contract`、`i18n`、`types`、`cli-plugins`（内置编程助手插件）、`bundle-ig-base` 与 `bundle-ig-mascot`（插件包，不 import electron；`bundle-ig-electron-caps` 只能作可选 peer，由宿主提供） | `electron`、任何视图包、`ui`                                                                                     |
| `host-electron`           | 以上全部 + `electron`                                                                                                                                                                                                                                                                         | 任何视图包（`ai-chat`、`renderer`、`ui`、`voice`、`avatar-runtime`）的源码与包入口（只加载构建产物；lint error） |
| 视图（ai-chat、renderer） | `contract` 的 client、`ui`、`i18n`、`avatar-runtime`、`@nomi-ai/cli-plugins/catalog`（纯数据的编程助手目录，lint 只放行这一子路径）                                                                                                                                                           | `core`、`host-*`、`electron`、`cli-plugins` 的其它入口（含 Node 实现）、`window.*IPC` / `window.electronAPI`     |
| `avatar-runtime`          | `character-contract`、浏览器 API                                                                                                                                                                                                                                                              | `electron`、`contract`（通过注入的事件源接 AI，§10.5）                                                           |
| `characters/*`            | 无（不含代码）                                                                                                                                                                                                                                                                                | —                                                                                                                |

### 3.3 包划分

| 新包 / 改名                   | 来源                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `packages/contract`           | 新建；合并两份 `channels.ts` 与 `electronAPI`                                       |
| `packages/host-ports`         | 新建                                                                                |
| `packages/core`               | 从 `packages/electron/src` 搬出业务模块（§12 P3）                                   |
| `packages/host-electron`      | `packages/electron` 改名，只留窗口、托盘、preload、协议、端口实现、传输适配、组合根 |
| `packages/host-node`          | 新建；无界面宿主，用于 e2e 和开发                                                   |
| `packages/character-contract` | 新建；搬入 `docs/character-pack/contract.json`、`voice-ids.json`、校验与迁移函数    |
| `packages/avatar-runtime`     | 从 `renderer/src/mascot` 拆出                                                       |
| `characters/nomi`             | 官方角色资产与人设集中到这里                                                        |
| `characters/test-dummy`       | 替身角色，只用于测试（§11.3）                                                       |

`gateway`、`cli-sdk`、`cli-plugins`、`bundle-ig-base` 已经是纯 Node，保持不动。

## 4. 契约层：`@nomi-ai/contract`

### 4.1 形态

```ts
export const contract = defineContract({
  version: { major: 1, minor: 0 },
  procedures: {
    'chat.stream': { kind: 'stream', input: ChatInput, chunk: ChatChunk, output: ChatResult },
    'sessions.list': { kind: 'query', input: z.void(), output: SessionList },
    'tools.confirm': { kind: 'mutation', input: ConfirmInput, output: z.void(), dangerous: true },
    'files.pick': { kind: 'mutation', input: PickInput, output: PickResult },
    'updates.check': { kind: 'mutation', input: z.void(), output: UpdateInfo },
  },
  events: {
    'cli.progress': CliProgress,
    'usage.updated': UsageSnapshot,
    'persona.changed': Persona,
  },
});
```

- 视图：`const api = createClient(contract, transport)`，然后 `api.chat.stream(...)`、`api.on('usage.updated', fn)`。
- 内核：`implement(contract, { 'chat.stream': async function* (input, ctx) { … } })`，缺方法或类型不符就编译失败。
- 现有 `IPC_METHODS` 的 `facade` / `method` / `kind` / `dangerous` 直接映射过来；`ai:<facade>:<method>` 通道名由 Electron 传输适配从过程名生成，不再手写。
- 两份 `channels.ts` 与快照测试删除。

### 4.2 按跨进程来设计

现在只有 Electron IPC，但契约从一开始就按「内核可能在另一个进程、通过网络访问」来约束。理由：换成 Tauri 时后端是 Rust，Node 内核只能作为 sidecar 进程运行，视图需要通过 WebSocket 访问它。

| 约束         | 规则                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可序列化     | 参数、返回值、事件只用 JSON 可表达的值；二进制用 `Uint8Array`；不传函数、class 实例                                                                                        |
| 流式         | `stream` = 请求 id + 若干 chunk 事件 + 结束 / 错误；取消用显式 `abort(id)`                                                                                                 |
| 不用同步调用 | 现有 `kind: 'sync-return'` 一律改为异步（它在 Electron 里也只是 `invoke`）                                                                                                 |
| 错误         | 统一 `{ code, message, data? }`，`code` 在契约里枚举；不透传 Error 对象；按名称 + 错误码识别（`isContractError(err, code?)`），不用 `instanceof`（跨副本 / 跨 realm 安全） |

### 4.3 版本与兼容

- `major` 变化 = 不兼容；视图启动时握手（`meta.version`），major 不一致直接提示，不进入半可用状态。
- `minor` 变化 = 只增不删：新增过程 / 事件 / 可选字段。
- 删除或改名先标 `deprecated`，保留一个 minor 版本。
- 契约包的改动必须带 changeset。视图和内核在 monorepo 里仍然一起发版，但版本号让「只改一侧」可以被检查。

### 4.4 为什么自己写而不用 tRPC / oRPC

| 方案                              | 优点                                                                                | 缺点                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **自研 `defineContract`（推荐）** | 在现有 `IPC_METHODS` 上扩展，约几百行；`dangerous`、caller 中间件、流式取消按需定制 | 类型推导、中间件要自己维护                                    |
| tRPC / oRPC                       | 类型推导和中间件现成，社区维护                                                      | 要为 Electron IPC 写 link；流式与取消语义要适配；多一个大依赖 |

**已定：自研**（2026-10-28）。已有一半基础，需求也比较定制。

## 5. 传输层

### 5.1 接口

```ts
// 视图侧
interface ClientTransport {
  call(name: string, input: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
  stream(name: string, input: unknown, opts?: { signal?: AbortSignal }): AsyncIterable<unknown>;
  subscribe(event: string, fn: (data: unknown) => void): () => void;
}

// 内核侧
interface ServerTransport {
  serve(router: Router): () => void; // 返回停止函数
}
```

`ClientTransport` 是现有 `IPCBridge` 的升级版：语义从「通道」改为「过程 / 事件」。

### 5.2 实现

| 实现         | 位置                  | 用途                                                                           |
| ------------ | --------------------- | ------------------------------------------------------------------------------ |
| Electron IPC | `host-electron`       | 生产。preload 只暴露一个 `window.nomiTransport`，取代 `aiIPC` 和 `electronAPI` |
| in-process   | `contract/testing`    | 单元测试与 `host-node` e2e，内核与视图逻辑在同一进程                           |
| WebSocket    | `host-node`（开发态） | 视图在普通浏览器运行；以后作为 sidecar 宿主的生产传输                          |

WebSocket 的服务端是 `@nomi-ai/host-node/websocket`，视图侧是 `@nomi-ai/contract` 的 `createWebSocketClientTransport`；
帧按文本发（`wire.ts`：JSON，`Uint8Array` 编成 base64）。握手、Origin 与 token 的规则见 §12 P4 第二步的进度说明。

### 5.3 事件分发

内核只调用 `ctx.events.publish('cli.progress', data)`，**不知道窗口**。由传输层根据订阅关系推给对应的客户端。现有 `EventBroadcaster` 的「按窗口订阅子集」能力并入传输层。

## 6. 宿主端口：`@nomi-ai/host-ports`

### 6.1 端口列表

```ts
export interface HostPorts {
  paths: { userData(): string; logs(): string; temp(): string; resources(): string };
  secrets: {
    available(): boolean;
    encrypt(plain: string): Promise<Uint8Array>;
    decrypt(cipher: Uint8Array): Promise<string>;
  };
  dialogs: {
    pickFiles(opts: PickOptions): Promise<string[]>;
    pickDirectory(opts: PickOptions): Promise<string | null>;
    saveFile(opts: SaveOptions): Promise<string | null>;
  };
  shell: { openExternal(url: string): Promise<void>; showItemInFolder(path: string): void };
  clipboard: { readText(): string; writeText(s: string): void; readImage(): Uint8Array | null };
  screenCapture: { capture(opts: CaptureOptions): Promise<Uint8Array> };
  power: { onSuspend(fn: () => void): () => void; onResume(fn: () => void): () => void };
  lifecycle: { onBeforeQuit(fn: () => void | Promise<void>): () => void; quit(): void };
  windows: WindowsPort; // §6.2
  capabilities: HostCapabilities; // §9
}
```

`dialogs` 指系统文件选择器。确认 / 输入类弹窗仍按 AGENTS.md 用视图内的 `confirmDialog` / `promptDialog`，不进端口。

### 6.2 窗口端口是声明式的

内核偶尔需要「打开对话窗口并跳到某个会话」「让看板娘窗口显示提醒」。它只表达意图，不操作窗口对象：

```ts
interface WindowIntent {
  route?: string;
  activate?: boolean;
  /** 临时召回：用户关掉的看板娘为一次确认临时显示，用完经 release 交还 */
  transient?: boolean;
}
interface WindowsPort {
  open(surface: Surface, intent?: WindowIntent): Promise<void>;
  focus(surface: Surface): void;
  isVisible(surface: Surface): boolean;
  hide(surface: Surface): void;
  anyFocused(): boolean;
  /** 界面的窗口是否存在（隐藏的也算） */
  isOpen(surface: Surface): boolean;
  /** 用户主动关掉了这个界面（看板娘：隐藏且静音，提醒改走灵动岛） */
  dismissed(surface: Surface): boolean;
  /** 交还一次 transient 召回；用户关掉的界面重新隐藏 / 释放窗口 */
  release(surface: Surface): void;
  /** 契约调用方（`CallerContext.id`）是否属于这个界面的窗口 */
  ownsCaller(surface: Surface, callerId: string | undefined): boolean;
  /** 调用方的窗口关闭时回调（找不到这个调用方时不登记） */
  onCallerClosed(callerId: string, fn: () => void): void;
}
```

窗口的尺寸、位置、透明、置顶、物理效果都是宿主自己的事。

**语音与桌面服务只经这个端口碰窗口**（2.0.5 收尾）。以前 `createCore` 收 `desktopWindows` / `voiceChatWindow` /
`callerWindows` 三个宿主钩子，内核拿到窗口对象与 `webContents`；现在全部删除，改成上面的意图：

| 需求                              | 内核调用                                                                           | Electron 实现                                      | host-node                              |
| --------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| 确认框需要看板娘，但用户关掉了她  | `open('mascot', { activate: false, transient: true })`；答复后 `release('mascot')` | `WindowManager.summonMascot()` / `releaseMascot()` | 记录 `open` / `release`                |
| 提醒走看板娘还是灵动岛            | `isOpen('mascot')`、`dismissed('mascot')`、`isVisible('mascot')`                   | 看窗口是否存在与 `mascotHidden()`                  | 按可见集合；`dismissed` 恒为 false     |
| 确认答复 / 拖入文件只认看板娘窗口 | `ownsCaller('mascot', ctx.caller.id)`                                              | 调用方 id = 窗口的 `webContents.id`                | `control.bindCaller(surface, id)` 声明 |
| VAD / 流式识别会话随发起窗口释放  | `onCallerClosed(String(owner), …)`                                                 | `webContents.once('destroyed')`                    | `control.closeCaller(id)` 触发         |
| 把识别结果投递到对话窗口          | `await open('chat')` 后发 `voice.inject`（surface `chat`）                         | 建 / 显示对话窗口                                  | 记录 `open`                            |

- 灵动岛是宿主独有的窗口，内核只发提醒：组合根注入 `desktopIsland: (notice) => boolean`（显示了返回 true，否则内核退回系统通知）。
- 流式识别的临时结果只属于发起方：`VoiceService.streamStart(owner, source, sink)` 收一个 `VoiceStreamSink { push, end }`，
  契约处理函数把它接到这次 `voice.streamStart` 调用的流上；会话结束（stop / cancel / 出错 / 发起窗口关闭）时服务调用一次
  `sink.end()`，流随之结束。会话表在服务里，router 不再持有按实例的会话表。
- `voice.inject` 进 pending 组（`CORE_PENDING_GROUPS.voiceInject`）：刚打开的对话窗口还没订阅时内核留着这条，视图先订阅再调
  `voice.takePendingInject` 拉取，不再靠「等页面加载完再延时 500ms」。

### 6.3 端口实现的位置

| 实现            | 内容                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host-electron` | Electron 实现（`src/host/electronPorts.ts`）；`ai-runtime` 的 `createElectronIpcAdapter` 已搬到 `src/host/electronIpcAdapter.ts`，`createElectronLifecycle` 删除（改用 `lifecycle` 端口） |
| `host-node`     | `paths` 指向临时目录；`secrets` 用内存或明文（仅测试）；`dialogs` 返回预设值；`windows` 记录调用；`processes` 可选用 Node 子进程（`forkUtilityProcess`）；`/core` 起无界面内核            |

`safeStorage` 只是 `secrets` 端口的一种实现。现有 `security/secretStorage.ts` 的逻辑（可用性检查、迁移）留在内核，只把 `safeStorage.encryptString` 调用换成端口。

## 7. 内核：`@nomi-ai/core`

### 7.1 组合根

```ts
// packages/core/src/createCore.ts（@nomi-ai/core/createCore）
export function createCore(deps: {
  ports: HostPorts;
  logger?: LoggerService; // 缺省按 ports.paths.logs() 新建
  config?: CoreConfig; // aiProfile、chatBackgroundPresetFile、autoSyncModels
  host?: CoreHostHooks; // 可选的宿主钩子，见下
  contract?: { hostHandlers?: (deps: ContractDeps) => Partial<AppHandlers>; middleware? };
}): Core;

interface Core {
  ports; logger; events; config; container; services; // services：只读的服务表
  router: Router<AppContract>; // start() 之后才有
  start(): Promise<void>; // 服务 + AI runtime + router（宿主就绪之后）
  startReminders(): void; // 能播报的界面就绪后：提醒与定时任务
  stop(): Promise<void>; // 可重入，带超时
}

// packages/host-electron/src/host/Application.ts（宿主组合根）
const ports = createElectronPorts({ windows: lazyWindowHost(() => windowManager) });
const core = createCore({ ports, logger, host: { … }, contract: { hostHandlers } });
await app.whenReady();
await core.start();
serveContractOverIpc({ router: core.router });
await windowManager.createMainWindow();
core.startReminders();
```

- 内核没有模块级单例：服务实例都在一次 `createCore` 调用的闭包里，一个进程可以有多个内核（P4 进度说明列出仍是进程级的东西）。
  `ServiceContainer`、`EventBus` 是内核里的类，按实例创建，不再导出模块级实例。
- 宿主片段**传进** `createCore`（`contract.hostHandlers`），不由宿主在外面合并：router 只 `implement` 一次，片段只能补内核
  没有实现的过程（重名报错），谁都没实现的过程以 UNAVAILABLE 失败，所以无界面宿主不给片段也能拿到完整的 router。
- 宿主钩子（`CoreHostHooks`，全部可选）：`updater`（自动更新）、`browser`（受控浏览器）、`characterPackProtocol`
  （`character-pack://` 注册）、`desktopIsland`（灵动岛提醒）、`liveWindows`（引导里的看板娘指令是否送达）、`aiPlugins` /
  `ttsProviders`（宿主的 AI 插件与系统 TTS）。打开 / 判断界面、核对调用方窗口、随窗口释放会话都走 `ports.windows`
  （声明式，§6.2）。
- 日志仍是 `LoggerService`（日志文件路径来自 `ports.paths.logs()`）与进程级的 `createMainLogger(scope)`，没有改成
  `LoggerFactory`。
- 主进程 i18n 与平台无关，已搬入内核（`core/src/i18n`）；界面语言变化通过 `settings.changed` 事件通知。

#### 实施约定（P2 起，P3 搬家前）

（P4 起组合根是内核的 `createCore` 与宿主的 `host/Application.ts`，令牌由 `createCore` 登记到它自己的容器；下文保留 P2 / P3
时的写法。）

`createCore` 落地之前，组合根仍是 `core/Application.ts`。它在构造时先建宿主端口、再建日志（`LoggerService` 的日志目录来自 `ports.paths.logs()`），日志建好后建事件总线，两者都登记到 `ServiceContainer`：

| 令牌（`core/serviceTokens.ts`） | 类型                                                   | Electron 实现                                                         |
| ------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `HOST_PORTS`                    | `HostPorts`（`@nomi-ai/host-ports`）                   | `host/electronPorts.ts`；窗口经 `lazyWindowHost` 在调用时找窗口管理器 |
| `APP_EVENTS`                    | `AppEvents`（`core/appEvents.ts`，不 import electron） | `host/electronAppEvents.ts`                                           |

迁移一个服务时：

1. **依赖从构造参数（或 `initXxxService(deps)`）进来**，类型写最小子集 `Pick<HostPorts, …>`。服务里不 `import 'electron'`，也不从容器里取（容器只给组合根用）。
2. **平台调用换端口**：`app.getPath('userData')` → `ports.paths.userData()`，`nativeTheme` → `ports.appearance` 等；端口缺能力就先在 `host-ports` 里加，同时补 `electronPorts` 与 `host-node` 两份实现。
3. **窗口广播换 `events.publish(channel, payload, { surface? })`**：通道名不变；不指定 `surface` 等于原来的 `BrowserWindow.getAllWindows()` 广播（跳过已销毁的窗口），`surface: 'mascot'` / `'chat'` 对应原来只发给看板娘 / 对话窗口的写法。
4. **测试不 mock 平台能力**：传假端口（或 `@nomi-ai/host-node`）和 `createRecordingAppEvents()`，断言 `events.published`；`jest.mock('electron')` 只留给还没迁移的依赖（如 `guardedIpc`）。
5. **从 `scripts/eslint/electron-boundary.mjs` 的白名单删掉该文件**，lint 保证它不再回退。

例外：组合根把原始的 Electron `protocol` 传给 `characterPack.init(protocol, logger)`，不为它加端口。注册 `character-pack://` 协议是宿主的事（§7.2 右列）；`CharacterPackService` 只认结构类型 `CharacterPackProtocolHost`，本身不 import electron，P3 拆分时协议注册随宿主 main 走。

参考实现是 `theme/ThemeService.ts`：

```ts
// 服务：只认端口和事件
export interface ThemeServiceDeps {
  file: string;
  ports: Pick<HostPorts, 'appearance' | 'app'>;
  events: AppEvents;
}
export class ThemeService {
  constructor(deps: ThemeServiceDeps) {
    /* … */
    deps.ports.appearance.onChange(() => {
      if (this.pref === 'system') this.broadcast();
    });
  }
  private broadcast(): void {
    this.events.publish(THEME_CHANGED, this.get()); // 原来：遍历 BrowserWindow.getAllWindows()
  }
}

// 组合根（Application.ts）
const themes = new ThemeService({
  file: path.join(this.ports.paths.userData(), 'theme.json'),
  ports: this.ports,
  events: this.events,
});

// 测试
const events = createRecordingAppEvents();
const svc = new ThemeService({ file, ports: { appearance: fakeAppearance, app }, events });
svc.set('ink');
expect(events.last(THEME_CHANGED)).toEqual({ pref: 'ink', resolved: 'ink' });
```

`registerIpc()`（`guardedHandle` / `ipcMain`）不在 P2 范围：它属于旧 IPC 注册层，P1 由契约传输层取代。

### 7.2 内核里留什么

| 进内核                                                                                                                                                                                                                                                                                                     | 留在宿主                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cli/` `usage/` `gateway/` `memory/` `knowledge/` `schedule/` `agents/` `extensions/` `local/` `voice/`（业务部分）`tts/` `diagnostics/` `onboarding/`（状态）`theme/`（偏好值）`character/`（包解析与校验）、`security/` 里与平台无关的部分（`netGuard`、`shellEscape`、`privateFile`）、`PersonaService` | `core/WindowManager` `TrayManager` `titleBar` `appIcon` `chatWindowBounds`、`mascot/`（窗口尺寸、桌面物理）、`island/`、`schemePrivileges`、`character-pack://` 协议注册、`security/windowGuards`、preload、自动更新的安装动作 |

`UpdateService` 拆两半：检查与下载状态在内核，安装重启在宿主（经 `lifecycle` 端口触发）。

## 8. 安全模型

现在的安全分布在两处：preload 只暴露具名白名单，`ai:*` 经 `security/ipcSenderGuard.ts`。它们实际表达的是「哪个界面可以调用哪些过程」。上移为 router 中间件后，换传输层安全语义也不会丢：

```ts
interface CallerContext {
  surface: 'chat' | 'mascot' | 'settings' | 'test';
  trusted: boolean; // 宿主确认来源是自家页面
}
```

- **传输层负责填 caller**：Electron 根据 webContents id 与加载的 URL 判断；WebSocket 用启动时下发的一次性 token，并且只监听 `127.0.0.1`。token 是挡住本机其他进程的唯一凭据（本机进程可以伪造 Origin / Host），所以它不进任何本机进程都能请求的页面 HTML：dev:web 只把地址注入页面，token 放在打印给开发者的地址片段 `#nomi-token=…` 里（片段不发给服务器），页面读到后存 sessionStorage 并用 `history.replaceState` 从地址栏抹掉。
- **router 中间件负责判定**：契约里每个过程可以声明 `surfaces: ['chat']`；`dangerous: true` 的过程只接受 `trusted` 调用者，必要时要求视图内确认。
- **事件也按界面限定**：契约的 `eventSurfaces` 列出只给某些界面的事件（确认请求、气泡、光标只给看板娘；编程助手会话、拖入总结、面板导航只给对话窗口），传输层在订阅时按调用者的界面过滤，其它界面的订阅被忽略。服务 `events.publish` 时写的 `surface` 只是意图，不决定投递。
- preload 只暴露 `window.nomiTransport` 与 `window.nomiHost` 两个对象，暴露面比现在更小。
- **视图能决定的入参都不可信**：契约过程的入参来自视图代码，页面里的任意脚本（XSS、被篡改的依赖）都能填。凡是「入参本身就是授权」的能力（如拖入文件的本机路径，内核会临时授权读取并发给模型），不做成契约过程，由 preload 自己取得并提交（`nomiHost.dropFile`，主进程 `host/nomiHostIpc.ts`）。
- 外部请求仍走 `netGuard`，命令参数仍用 `shellEscape`，这些都在内核里，与宿主无关。

## 9. 宿主特有能力

透明浮窗、点击穿透、托盘、灵动岛、窗口拖拽区、红绿灯按钮位置都和平台强绑定。抽象成最小公分母只会让每个宿主都做不好，所以不抽象，改为声明：

```ts
interface HostCapabilities {
  transparentWindow: boolean;
  clickThrough: boolean;
  tray: boolean;
  island: boolean;
  nativeTitleBar: 'mac-traffic-lights' | 'win-controls' | 'none';
}
```

- 视图通过契约的 `host.capabilities` 查询，按能力降级（比如没有透明窗口时，看板娘以内嵌模式显示在对话窗口里）。
- 这部分代码留在 `host-electron`，不追求跨宿主复用。

## 10. 角色解耦

### 10.1 先分清三个概念

| 概念 | 例子                                      | 归属                            |
| ---- | ----------------------------------------- | ------------------------------- |
| 产品 | 应用名 Nomi AI、appId、更新通道、主题令牌 | 宿主（`brand`），角色包不得覆盖 |
| 角色 | 角色名、人设、立绘、语音、台词            | `characters/<id>`               |
| 引擎 | Rive / sprite / static 渲染与驱动         | `avatar-runtime`                |

产品常量只有一个来源：`@nomi-ai/types` 的 `brand`（`appName`、`appId`；`host-electron/src/brand.ts` 只是转出，`electron-builder.yml` 的 `productName` / `appId` 由测试守住一致）。原来 `APP_DISPLAY_NAME_ZH = 'Nomi·诺米'` 里的「诺米」属于角色，已删。全仓库的 `Nomi` / `诺米` 逐一归类（G5 已完成，见 §12）：产品用法（应用名、「Nomi 对话」「Nomi 网关」）用 `brand.appName` 或保留产品名；指桌面上那个角色的用法（「显示 X」「X 工具栏」「你好，我是 X」）用当前角色的人设 `displayName`，自我介绍等台词进角色包 `locales/`；§11.2 的检查守住。

### 10.2 角色包只含数据

```
characters/nomi/
  manifest.json        id、contractVersion、assets.mode、capabilities、layout（窗口尺寸、命中区、气泡锚点）
  persona.json         displayName、systemPromptIdentity、pronoun、addressUser、greetings、tips
  mapping.json         语义 → 引擎资源（§10.5）
  locales/{zh,en}.json 角色台词、提示语、语音字幕
  rive/ sprite/ static/
  voice/{id}.mp3
  onboarding/{welcome,profile,provider,privacy}.webp
  CREDITS.md / LICENSE
```

- **不含代码**。引擎是应用内注册的插件，包通过 `assets.mode` 选择。这样第三方包不会执行任意 JS，安全模型也简单。
- 官方 Nomi 只是 `characters/nomi`，和第三方包走同一条加载路径。契约里「没有 `CHARACTER_PACK` 时与今天一致」改为「默认包 = `nomi`」，删除 Scheme A 的原地覆盖（`packages/renderer/public/...`、`Onboarding/art` 等覆盖目标）。
- 角色文案跟着包走，不进全局 `en.json`（**已定**，AGENTS.md 已同步）：界面文案归 `i18n`，角色文案归角色包。`pnpm check:i18n` 增加对角色包 `locales` 的同样检查。

### 10.3 `@nomi-ai/character-contract`

- 内容：manifest / persona / mapping 的类型与 zod schema、`contract.json`、`voice-ids.json`、`validatePack()`、各版本迁移函数（例如 `skirt → hem`）。
- 使用者：打包脚本（`character:apply`）、内核的包解析（`CharacterPackService`）、`avatar-runtime`。三者都只依赖契约包，互相不依赖。
- manifest 声明 `contractVersion`；运行时按 `capabilities` 降级，未知动作跳过。

### 10.4 人设只有一个来源

内核提供 `PersonaService`，经契约暴露 `persona.get` 与 `persona.changed` 事件：

```ts
interface Persona {
  characterId: string;
  displayName: string;
  systemPromptIdentity: string;
  pronoun?: string; // 界面里指代角色的人称；没给时「它 / it」
  addressUser?: string;
  greetings: string[];
}
```

- 角色 preset（`CompanionAgentPresetPlugin`，C3 前叫 `WaifuAgentPresetPlugin`）与对话的默认系统提示都从这里读。默认系统提示由内核拼装（`core/src/persona/systemPrompt.ts`：身份段 + 与角色无关的对话要求，跟随界面语言），ai-chat 经契约 `persona.systemPrompt` 取，界面包里不拼人设。
- 删除两处硬编码：`WaifuAgentPresetPlugin.ts`（现 `CompanionAgentPresetPlugin.ts`）的「你是 Nomi（诺米）……」兜底，以及 `IPCClient.ts` 使用的 `you-are-nomi-an-ai-companion-who-lives` key（文本搬进 `characters/nomi/persona.json`，同时删 `en.json` 对应条目）。
- 两份 `character.generated.json` 删除，由 `PersonaService` 和 `avatar-runtime` 从同一个解析结果读取。

**这一步改动最小，并且直接修复「换了皮，人设还是 Nomi」的问题，排在最前（§12 P0）。**

### 10.5 AI 与角色之间只传语义事件

AI 不再知道动作名和 clip 名：

| 方向      | 事件                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| AI → 角色 | `emotion(name, weight)`、`speaking(start / stop, envelope)`、`activity(thinking / toolRunning / idle)`、`gesture(name)` |
| 角色 → AI | `touched(hitbox)`、`clicked`、`scene(…)`（取代原 `WaifuMascotSceneReporter`：角色 id 与它有映射的语义名）               |

- 角色包的 `mapping.json` 把语义翻译成自己的资源，例如 `happy → smile_02`、`toolRunning → typing_loop`；没有映射就忽略。
- 项目没有 Live2D 运行时，`live2d` 只是历史命名，挂在驱动 Rive / sprite 的在用链路上。处理：没有调用方的部分（例如 `setParameter`、`LIVE2D_NOT_AVAILABLE`）直接删；在用的部分改名为 avatar，**不保留旧名别名**。
- 工具改名：`live2d_play_motion` → `avatar_gesture`，`live2d_set_expression` → `avatar_emotion`（C3 起只收语义名）；preset 名 `waifu` → `companion`。
- 词表在 `character-contract`（`SEMANTIC_EMOTIONS` / `SEMANTIC_ACTIVITIES` / `SEMANTIC_GESTURES`）；没有 `mapping.json` 的包用引擎默认映射（与 `characters/nomi/mapping.json` 相同）。照 2.0.5 模板写的 `mapping.json`（情绪指向动作，`happy → nod`、`sad → tears` …，`isLegacyMapping`）validatePack 不用、给 `mapping-legacy` 警告，运行时同样退回默认映射——2.0.5 本来就不读 mapping.json，这样旧覆盖包行为不变。
- `ai-sdk` 的 `Live2dFacade` → `AvatarFacade`，`Live2dSeamPlugin` / `seams/live2d.ts` → avatar，事件 `live2d:touch` → `avatar:touch`。
- 保留 `ConfigIpcHandler` 中清理旧 `displayMode: 'live2d'` 配置的迁移逻辑（它处理的是用户磁盘上的旧数据）。

### 10.6 `@nomi-ai/avatar-runtime`

从 `renderer/src/mascot` 拆出，纯浏览器包：

- **内容**：`MascotBackend` 接口与 `backends/`（rive / sprite / static）、`expressionDirector`、`mood`、`motion`、`rig`、`layeredRig`、`interaction`（命中区）、口型消费。`characterVoice`（角色语音偏好）留在 renderer：它属于宿主的朗读链路，运行时只经 `onInteraction` 报出「这句要朗读」（见 §12 C2 的进度说明）。
- **输入**：`manifest + mapping + resolveAsset(path) → url` + 一个 `AvatarEventSource`（语义事件流），情绪 / 活动 / 手势按 mapping 翻译（`mapping.ts`）。
- **输出**：交互事件（`onInteraction`，带台词）与语义事件（`onAvatarEvent`：`touched`、`clicked`、`scene`）。
- **不依赖** `contract`、`electron`、`ai-sdk-client`。`AvatarEventSource` 由 renderer 用契约 client 实现并注入，所以 avatar-runtime 可以单独在网页里运行（`packages/avatar-runtime/demo`）。

renderer 只保留：透明窗口壳、气泡、工具栏、右键菜单，以及把契约事件接到 `AvatarEventSource` 的薄适配层（现在的 `src/ai`）。

### 10.7 以后要做多角色切换时

本稿不做，但不能堵死：

- `PersonaService` 和 `avatar-runtime` 都以「当前角色 id」为输入，不假设只有一个；
- `avatar-runtime` 的 `mount / dispose` 必须能完整释放资源（为热切换做准备）；
- 开放社区角色包前还需要：包签名、资产大小与格式校验、许可字段必填、契约冻结。

## 11. 守护与验收

### 11.1 边界规则（CI，error 级）

- `core`、`host-ports`、`contract`、`character-contract`、`avatar-runtime` 禁止 import `electron`，**包括** `nodeRequire('electron')` / `require('electron')` 这类动态写法（自定义 lint 规则或 grep 检查）。
- 视图禁止访问 `window.aiIPC`、`window.electronAPI`、`window.nomiTransport`，只能经 `createClient`（集中在一个文件里）。
- 视图禁止 import `core`、`host-*`；内核禁止 import 任何视图包与 `ui`。
- 任何包禁止 import `characters/*`，只能经包解析读取。

工具：ESLint `no-restricted-imports` + `no-restricted-syntax` / `no-restricted-globals` 与自定义规则 `nomi/no-dynamic-electron`，全部 error 级（`eslint.config.mjs`）：第一条由 `ELECTRON_FREE_PACKAGES` 与动态加载规则守住（白名单为空）；第二条禁止视图访问上述全局；第三条是视图（`renderer`、`ai-chat`、`ai-sdk-client`、`ui`、`voice`）不 import `@nomi-ai/core` / `@nomi-ai/host-*`，内核不 import 视图包与 `ui`；第四条是所有包的 `CHARACTER_PACK_IMPORT`（`**/characters/**`）。唯一的例外是 renderer 的 `spriteLayout.test.ts` 读内核的窗口尺寸做一致性断言，行内注明理由。

### 11.2 名字扫描

`scripts/check-character-leak`：`characters/nomi` 与 `brand` 之外不得出现角色名（`诺米`、角色语境下的 `Nomi`）。产品名统一用 `brand.appName`。允许清单写在脚本里，加条目要说明理由。

已实现（`pnpm check:character-leak`，CI 与 `check:i18n` 并列）：扫 `packages/*/src`、`packages/*/config`、`electron-builder.yml` 与 `characters/nomi` 以外的角色包；判定规则在 `scripts/lib/characterLeak.mjs`（「诺米」出现即算；「Nomi」只在角色语境下算：自称、「显示 / 关闭 / 桌面 Nomi」「Nomi 工具栏」「Nomi's bubble」、同句里的她 / her、官方 Rive 画板名），替身 e2e 复用同一份规则。测试与文档不扫。允许清单现在是空的。

### 11.3 替身验收（最关键）

| 验收                 | 做法                                                                                                                                                                                                                                                                                                         | 证明   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 无界面宿主跑通 e2e   | `host-node` + in-process 传输，在 Vitest 里启动整个内核，跑现有 `e2e/` 用例；不需要 Electron 和 xvfb                                                                                                                                                                                                         | G1、G4 |
| 视图在普通浏览器运行 | 开发态内核开 WebSocket 传输，ai-chat 在 Chrome 直接打开 6128 也能对话                                                                                                                                                                                                                                        | G2     |
| 替身角色             | `characters/test-dummy`：static 模式、一张占位图、名字与人设完全不同；用它跑 e2e，断言界面文本与发出的系统提示中都不含 `Nomi` / `诺米`（产品名区域除外）。已通过：`e2e/tests/E8.stand-in-character`（无界面宿主上的真实内核）与 `e2e-headed/tests/G5.stand-in-character`（`pnpm build:stand-in` 的替身构建） | G5     |
| 契约兼容             | 契约 major 不变时，旧视图构建对新内核跑一遍冒烟                                                                                                                                                                                                                                                              | G3     |

## 12. 迁移计划

> 进度（2026-10-28，分支 `refactor/core-host-decoupling`）：第一批已完成 live2d 清理（§10.5 的改名部分）、`contract` / `host-ports` / `host-node` / `character-contract` 四个新包骨架、Electron 端口实现（`electron/src/host/electronPorts.ts`）、P0。P1a（AI 门面上契约）已在分支 `refactor/p1-contract` 完成。
>
> P2 主体完成（分支 `refactor/p2-host-ports`）：组合根登记 `HOST_PORTS` / `APP_EVENTS`；`cli/` `usage/` `gateway/` `agents/` `memory/` `knowledge/` `schedule/` `extensions/` `local/` `chat/` `diagnostics/` `voice/` `tts/` `desktop/` `services/` `startup/` `onboarding/` `i18n/` `character/` `theme/` 的服务改用宿主端口与 `events.publish`，组合根里的窗口广播也走 `events.publish`；端口补了 `windows.anyFocused()` 与 `app.preferredLanguages()`；P0 白名单删掉 29 个不再 import electron 的文件。剩下的（都还在 `scripts/eslint/electron-boundary.mjs` 白名单里）：
>
> - `ai/`：`mascotCommand`（窗口广播）、`AIRuntimeBoot`、`ClipboardGateway` / `ScreenCapture`（端口的 Electron 实现在复用它们，P3 随宿主搬家）；
> - `desktop/DesktopService`：系统通知（`Notification`）与打开对话窗口时判断窗口数（`BrowserWindow`）；`chat/ChatBackgroundService`：`nativeImage` 缩放大图；两者的 `registerIpc` 仍用 `ipcMain`（P1b 取代）；
> - `chat/assetProtocol`：`chat-asset://` 协议注册（`protocol.handle`）是宿主工作，P3 随协议注册移入宿主；
> - `gateway/GatewayProcess`、`desktop/parse/runParse`：`require('electron').utilityProcess` 拉子进程，等进程端口；
> - 缺的端口：系统通知（notifications）与图片处理（image：解码 / 缩放），补上后 `DesktopService` / `ChatBackgroundService` 才能出白名单；
> - `security/secretStorage`、`utils/log`、`utils/privateFile` 仍直接用 `safeStorage` / `app`，旧 IPC 注册层与 `sandbox/AgentBrowser`、`utils/windowBounds` 按原计划在 P1b / P3 处理。
>
> 搬目录（P3）当时尚未开始；后来已完成，见下文「P3 第一步 / 第二步 / 第三步」。
>
> C1 已完成（分支 `refactor/c1-characters`）：官方角色是普通角色包 `characters/nomi`，构建期由
> `CHARACTER_PACK`（缺省为它）选包，Vite 插件直接读包、不改源树；Scheme A 原地覆盖与两份
> `character.generated.json` 已删除；运行时覆盖包与内置包都经 `validatePack`（覆盖包 `lenient`，
> 非结构性问题只警告）。官方包与 2.0.5 行为对齐：不声明 `layout.hitboxes` / `bubbleAnchor`（触摸仍走几何
> 推断），`manifest.catalog` 让生成的 `model-list.json` 与 2.0.5 一致（仅素材路径改到 `./character/`）。
> 当时列的后续项都已完成：
>
> - 替身角色 `characters/test-dummy` 跑 e2e（§11.3，G5 已达成，见下文「G5 完成」）；
> - 名字扫描 `scripts/check-character-leak.mjs`（§11.2，`pnpm check:character-leak` 进 CI）；
> - 界面文案按「产品名 / 角色名」分拣（§10.1，G5）；
> - `examples/static-demo.pack` 已是新布局（`manifest.json` + `persona.json` + `locales/`）；
> - `character.getActivePack` 的契约输出已含 `locales` 与身份字段（`contract/src/app/mascot.ts`）。

> P1b 基础已完成（分支 `refactor/p1b-contract`）：应用契约按域拆成五个文件（`contract/src/app/{media,shell,coding,knowledge,mascot}.ts`，
> 版本 1.1）；宿主侧 `electron/src/host/contract/` 组装 router（`createAppRouter`：AI 门面 + 五个域，AI runtime 失败时
> 其余域照常可用）、事件桥（`createContractEventBridge`：服务照旧 `events.publish(<旧通道>)`，桥接表里的通道同时发成契约事件）
> 与服务表（`ContractServices`，组合根创建服务时登记）；视图各有唯一的 `services/api.ts`（`createAppClient()`，与
> `ClientAIClient` 共用窗口共享的契约传输，一个窗口一个会话）。各域按下文「P1b 实施约定」并行迁移。

> P1b 已完成（分支 `refactor/p1b-contract`）：五个域共 320 个过程、57 个事件进了应用契约（`contract/src/app/<域>.ts`，
> 处理函数在 `electron/src/host/contract/<域>.ts`）。收尾批次：
>
> - preload 只暴露 `window.nomiTransport`（契约传输）与 `window.nomiHost`（`pathForFile(file)`：拖入 / 粘贴文件的本机路径，
>   `webUtils.getPathForFile` 只能在 preload 里对真实 File 调用，不能进契约；`dropFile(file)`：看板娘窗口拖入文件，
>   路径在 preload 里解析并经专用通道 `desktop:drop-file` 直接提交（主进程 `host/nomiHostIpc.ts`，再校验发送方是看板娘窗口）。
>   拖入总结不做成契约过程：过程的入参由视图决定，页面里的任意脚本就能让内核读任意路径并发给模型）；`window.aiIPC` / `window.electronAPI`、
>   `mkAiPreload`、`packages/types` 的 `IpcApi` / `MascotWindowApi` / `DesktopApi` / `PersonaApi` 已删除；
>   `WindowManager` 的 preload 守护改为探测这两个全局；
> - 主进程的旧注册层全部删除：各服务的 `registerIpc()`、`handlers/ipc/*`（`IpcRegistry` / `ConfigIpcHandler` /
>   `VoiceIpcHandler` / `WindowIpcHandler`，窗口操作留在 `host/mascotWindowActions.ts`）、`security/guardedIpc.ts`、
>   编排器的 `rendererSubscribers`、看板娘控制器里的 `ipcMain` 监听，以及 ai-runtime 的 `ProviderIpcServer` /
>   `CapabilityIpcServer` / `AiChatCompat` / `createGuardedIpcAdapter`；`TtsService` 与旧 displayMode 清理改在启动任务
>   `init-config-services` 里做；
> - 事件只走契约：`createContractEventBridge` 不再向窗口广播旧通道（`host/electronAppEvents.ts` 已删），桥接表外的通道
>   每个记一次 warn；`WindowManager.openProviderPanel` 与窗口鼠标进出、看板娘指令、窗口控制器推送都经 `events.publish`，
>   面板导航（`providers.openPanel`、`nav.*`）因此在契约上生效；
> - 视图里不再有 `window.aiIPC` / `window.electronAPI` / 原始 IPC；`@nomi-ai/voice` 去掉旧通道适配（`voiceApi(bridge)`），
>   `VoiceApi` 改为显式接口，只经 `setVoiceBackend` 注入；
> - lint（§11.1）：视图包除 `services/api.ts` 外不得访问 `aiIPC` / `electronAPI` / `nomiTransport` / `nomiHost`，不得 import
>   建客户端的工具或 `ipcRenderer`；`packages/electron/src` 的 `host/` 之外不得使用 `ipcMain`；单测
>   `tests/unit/security/ipcSurface.test.ts` 再扫一遍（`ipcMain` 注册、`webContents.send`、preload 只有两个全局）；
> - e2e-headed 与 `scripts/measure-*.mjs` 经页面里的极小契约客户端（`e2e-headed/fixtures/contract.ts`、
>   `scripts/lib/contractProbe.mjs`）驱动内核。
>
> 剩下的：
>
> - 服务仍 `events.publish(<旧通道名>)`，由桥接表转成契约事件；以后可以让服务直接发布契约事件名，再删掉桥接表
>   （`types` 里的 `QUALITY_IPC` 等旧通道常量随之删除）；
> - 契约事件按订阅分发；哪些界面能订阅由契约的 `eventSurfaces` 决定（§8），`events.publish` 的 `surface` 只是发布方意图、
>   不决定投递。router 建好之前、或新窗口还没订阅时发布的事件会丢掉：`desktop.summary` 与面板导航仍靠固定延迟
>   （400 / 600 ms）等对话窗口订阅，以后改成对话窗口挂载时拉取待处理的导航与总结；
> - ai-chat 的部分视图测试仍用旧形状的假 `window.aiIPC`，经 `tests/helpers/{codingApi,shellApi}.ts` 把契约调用转回旧通道名，
>   以后改成契约层的假实现；
> - e2e-headed 只在 macOS 上跑过部分用例（E5、E17 等），完整一轮要在 Linux + xvfb 上跑；看板娘拖拽 / 点击上报从单向消息
>   变成契约往返，拖拽上报已串行化并按帧合并 move（renderer `mascot/interaction/dragReporter.ts`，上一条回应前不发下一条），
>   发布前仍要在 Windows 真机上确认拖拽手感；
> - 两个 preload 内容已相同，可以合成一个包；`security/ipcSenderGuard.ts` 仍在 electron import 白名单里（P3 随宿主搬家）；
> - `voice-settings:changed`（→ `voice.mascotSettingsChanged`）主进程没有发布方；MCP 信任级别（`ext.mcpUpsert` 等）
>   是否算 `dangerous` 待定。

> P3 第一步完成（分支 `refactor/p3-core`）：P0 的 electron import 白名单只剩本质上是宿主工作的文件。
>
> - 端口补了三个（`host-ports`，Electron 实现在 `host/electronPorts.ts`，无界面实现在 `host-node`）：`notifications`
>   （系统通知，图标由宿主给）、`image`（`size` / `resize`，Electron 是 `nativeImage`）、`processes`（工具子进程，
>   Electron 是 `utilityProcess`，子进程经 `process.parentPort` 收发）；`host-node` 默认解码不了图片、没有工具子进程，
>   可用选项注入；
> - `DesktopService` 经 `notifications` 弹系统通知，窗口只用结构类型（`DesktopMascotWindow` / `DesktopChatWindow`，
>   拖入总结判断对话窗口是否已开改为 `chatOpen()`）；受控浏览器移到 `host/AgentBrowser.ts`，由组合根注入
>   （缺省时 `browser_*` 工具报不可用）；`ChatBackgroundService` 经 `image` 缩放大图；`GatewayProcess` 与
>   `parseFile` 经 `processes` 拉子进程（没有时网关报不可用、解析退回进程内，与以前没有 Electron 时一致）；
> - `security/secretStorage` 改为 `createSecretBox(secrets)`（`enc:` 前缀、失败关闭、旧明文兼容留在内核），语音与扩展服务
>   用 `ports.secrets`；ai-runtime 的 `createSafeStorageCipher` 经 `safeStorageFromSecrets(ports.secrets)` 用同一个端口；
> - 模块级的宿主设置集中在 `host/processDefaults.ts`（`main.ts` 第一个加载）：`utils/log` 的「是否正式打包」
>   （`setMainLogPackaged`）、`utils/privateFile` 自动收紧 ACL 的根目录（`setPrivateRoot`，第一次用到时才取 userData）、
>   `ai/mascotCommand` 报告的存活窗口数（`setMascotLiveWindows`）；没设置的进程（工具子进程、单测）按以前拿不到
>   `app` 时的行为：日志按开发态、不自动收紧目录、窗口数为 0；
> - 宿主工作搬进 `host/`：`ClipboardGateway`、`ScreenCapture`、`windowBounds`、`ipcSenderGuard`、`assetProtocol`
>   （`chat-asset://` 协议注册）、`AgentBrowser`；`AIRuntimeBoot` 改收端口（`paths.appPath()`、`secrets`、
>   `lifecycle.onBeforeQuit`）；
> - ai-runtime 不再认识 Electron：`createElectronLifecycle` 与 `nodeRequire` 删除（只留 `NoopLifecycle`），
>   `createElectronIpcAdapter` 移到 `host/electronIpcAdapter.ts`，ai-runtime 只留 `IpcAdapter` 类型；
>   `tests/unit/security/ipcSurface.test.ts` 相应允许宿主目录里的这个适配器直接用 `ipcMain`。
>
> 白名单里剩下的（`scripts/eslint/electron-boundary.mjs`）：
>
> - `ELECTRON_IMPORT_ALLOWLIST`：`core/Application.ts`（组合根：创建窗口管理器与端口、注册协议与会话权限、接 IPC
>   传输），搬家时拆成内核 `createCore` 与宿主 main；
> - `ELECTRON_DYNAMIC_ALLOWLIST`：`bundle-ig-electron-caps/src/electronLoader.ts`，这个插件包本身就是 Electron 版的
>   插件能力（截屏 / 剪贴板 / 安全存储 / 快捷键 / 会话存储），以后改成插件能力经宿主端口注入。
>
> 剩下的：
>
> - 业务模块仍 import 宿主目录里的模块（`DesktopService` → `island/IslandService` 的 `notifyIsland`；
>   `ai/mascotCommand` → `mascot/mascotEvents`、`services/ConfigService` → `mascot/mascotSize`，后两个不依赖
>   electron），lint 只拦 electron import、不拦「内核 → 宿主」；物理搬家（业务模块 → `packages/core`）前要先把
>   灵动岛提醒改成端口或事件，纯数据模块随内核搬走；
> - `host-node` 的 `image` / `processes` 默认不可用：无界面宿主跑 e2e（P4）时，背景图不缩放、文档在进程内解析、
>   统一网关起不来，要用的用例需注入实现；
> - `bundle-ig-electron-caps` 的能力端口化（见上）。

> P3 第二步完成（分支 `refactor/p3-core`）：业务模块物理搬进 `packages/core`（`@nomi-ai/core`，纯 Node，不依赖 Electron）。
>
> - 搬家（`git mv`，单测随模块走）：`cli/` `usage/` `gateway/` `memory/` `knowledge/` `schedule/` `agents/`
>   `extensions/` `local/` `voice/` `tts/` `diagnostics/` `onboarding/` `theme/` `character/` `persona/` `i18n/`
>   `startup/` `desktop/` `sandbox/` `screen/`，以及 `chat/ChatBackgroundService`、`core/{ServiceContainer,EventBus,
appEvents,serviceTokens,lifecycle}`、`security/{netGuard,shellEscape,secretStorage}`、`utils/{privateFile,log,
coalescedWriter,redact}`、`services/{Logger,Config,Cache,Update}Service`、`mascot/{mascotEvents,mascotSize}`（纯数据）、
>   `ai/{mascotCommand,gatewayUsage,mascotBridge}`；目录结构不变；
> - 包形态：tsc 编译成 CommonJS 到 `dist/`，`exports` 按子路径导出（`@nomi-ai/core/<模块路径>`，`i18n`、
>   `gateway/agents`、`cli/harness` 三个目录入口单列）；electron 从这里 import，它的 Jest 把 `@nomi-ai/core/*` 映射到
>   内核源码（不用先构建，`jest.mock('@nomi-ai/core/…')` 与内核内部的相对 import 是同一个模块）；内核测试仍用 Jest
>   （electron 的 setup 去掉 electron 模拟），搬过来的测试里的 `jest.mock('electron')` 删除；mock CLI 与
>   `smoke-silero.cjs` 搬到 `packages/core/scripts/`；`pnpm dev` 同时跑内核的 `tsc -w`；
> - 反转的依赖：灵动岛提醒经组合根注入的 `desktopIsland`（宿主的 `IslandService.notify`，`IslandKind` / `IslandNotice` 在
>   `core/desktop/islandNotice.ts`）；`UpdateService` 只管检查 / 下载状态、重试与设置，`electron-updater` 的
>   `autoUpdater`（含 `quitAndInstall`）由组合根作为 `updater` 注入；内置背景预设图的路径本来就由宿主给，
>   `chat/backgroundPreset.ts` 留在宿主；
> - 契约：不碰窗口的片段进内核 `contract/{types,services,eventBridge,coding,knowledge}.ts`（`CoreContractServices`、
>   泛型 `ContractDeps<S>`）；宿主 `host/contract/` 留 `media`（`windowManager.openProviderPanel`）、`shell`（`appIcon`、
>   AI runtime 的供应商）、`mascot`（看板娘窗口、灵动岛）与 `index.ts`（`createAppRouter`，组装 AI 门面），宿主的
>   `ContractServices` 在内核服务表上加 `windowManager` / `windowActions` / `aiRuntime` / `island`；
> - 守护（§11.1）：ESLint（error）禁止 `packages/core` import electron、`electron-*` / `@electron/*`、宿主包（含
>   `bundle-ig-electron-caps` 与 `electron/src` 路径）、视图包与 `ui`；内核单测断言 `package.json` 不含这些依赖；
>   `ipcSurface` 单测同时扫内核源码；
> - 打包：electron 依赖 `@nomi-ai/core`（`workspace:*`），electron-builder 顺着依赖把 `node_modules/@nomi-ai/core/dist`
>   打进 asar（工具子进程与 worker 脚本仍在 `__dirname` 旁边），内核的源码、测试与脚本排除；随内核搬走的运行时依赖
>   （`fflate`、`onnxruntime-web`、`smol-toml`、`tesseract.js`、`unpdf`、`ws`）从 electron 的 `package.json` 移到内核。
>   `electron-builder --dir`（macOS arm64）打包通过，asar 里能解析并加载内核模块。
>
> 没有抽出 `createCore(deps)`（§7.1）：`core/Application.ts` 仍是组合根，内核服务的创建与窗口、托盘、协议、会话权限
> 交织在同一个启动流程里，拆开要重排启动顺序，留给 P4（无界面宿主跑 e2e 时一起做）。
>
> 剩下的：
>
> - `createCore` 与宿主 main 的拆分（见上）；`packages/electron` 改名 `host-electron` 未做；
> - 留在宿主、但本质是业务的：`ai/AIRuntimeBoot.ts`（依赖 `bundle-ig-electron-caps`）、`ai/TtsElectronNativeProvider.ts`
>   与 `services/AdvancedTTSEngine.ts`（系统 TTS，读 `process.resourcesPath`）、`core/BootstrapManager.ts`、
>   `utils/ErrorHandler.ts`；契约处理函数 `media` / `shell` 要等声明式窗口意图（`windows.open(…)`）与应用图标端口；
> - 内核依赖 `ai-runtime`，后者的 `package.json` 仍把 `bundle-ig-electron-caps` 与（可选的）`electron` 列为 peer；
> - 内核里仍有模块级单例（`getXxxService()`、`eventBus`、`setMascotAppEvents` 等），`createCore` 时收进实例；
> - e2e-headed（真实 Electron）没有跑，要在 Linux + xvfb 上跑一轮。

> P3 第三步完成（分支 `refactor/p3-core`）：`packages/electron` 改名 `packages/host-electron`，包名
> `@nomi-ai/host-electron`（`git mv`）。
>
> - 引用全部改到新路径 / 包名：锁文件、`turbo.json`（任务键与 inputs）、根 `package.json`（`dev` / `dev:libs` /
>   `build:electron`）、ESLint（`eslint.config.mjs` 与 `scripts/eslint/` 的宿主区域与白名单；内核禁止 import 宿主的规则
>   改为 `@nomi-ai/host-electron` 与 `**/host-electron/src/**`，用临时文件确认仍报错）、`scripts/`（i18n 扫描、发布脚本读的
>   版本号、测量脚本）、`e2e-headed/`（应用目录与解析 electron 的起点）、ai-chat 的 Vite 配置（CSP）、CI、CODEOWNERS、
>   素材许可登记（`assets-licenses.json`、`CREDITS.md`、`THIRD_PARTY_NOTICES.md`）、changeset 配置的 `ignore` 与待发布
>   changeset 的包名、AGENTS.md 与文档；`pnpm-workspace.yaml` 用 `packages/*`，不用改；各包 CHANGELOG 与本节之前的进度
>   说明保留旧名；
> - 运行时应用名不随包名变（评审修正，见下方「P3 评审修正」）：`package.json` 加 `productName: @nomi-ai/electron`，
>   `electron-builder.yml` 的 `extraMetadata` 加 `name: '@nomi-ai/electron'`，开发态与打包后的 userData 目录、钥匙串条目、
>   更新缓存目录都和改名前一样；
> - 在 macOS 上从改名后的包启动真实应用跑了 e2e-headed 的 E5（生产模式冒烟）与 E17（契约驱动 harness），
>   `electron-builder --dir`（macOS arm64）打包通过。
>
> **P3 小结**：业务模块在 `packages/core`（纯 Node），宿主在 `packages/host-electron`，ai-runtime 不再认识 Electron；
> §12 表里的完成标准还差两项，都留给 P4：
>
> - P0 白名单没有清空：`core/Application.ts` 仍是组合根（内核服务的创建与窗口、托盘、协议、会话权限在同一个启动流程里），
>   要拆成内核 `createCore(deps)` 与宿主 main；`bundle-ig-electron-caps/src/electronLoader.ts` 要等插件能力经宿主端口注入；
> - 宿主里还有本质是业务的代码：`ai/AIRuntimeBoot.ts`、`ai/TtsElectronNativeProvider.ts`、`services/AdvancedTTSEngine.ts`、
>   `core/BootstrapManager.ts`、`utils/ErrorHandler.ts`，以及契约处理函数 `media` / `shell`（等声明式窗口意图与应用图标端口）；
> - 内核里的模块级单例（`getXxxService()`、`eventBus` 等）、ai-runtime 的 `package.json` 仍列 `bundle-ig-electron-caps` 与
>   `electron` 为 peer，见上一条进度说明；
> - e2e-headed 完整一轮仍要在 Linux + xvfb 上跑。

> C2 已完成（分支 `refactor/c2-avatar`，已变基到 `refactor/p3-core`）：角色引擎拆成纯浏览器包 `packages/avatar-runtime`（`git mv` 保留历史）：
> `MascotBackend` 与 `backends/`（rive / sprite / static）、`expressionDirector` / `emotion` / `mood` / `voiceMood`、
> `motion` / `rig` / `layeredRig`、`interaction`（命中区、手势、反应、互动设置）、`spriteInteraction` / `layoutStore`、
> 三种画布与 `InteractionLite`、按 `mode` 选画布（Rive 失败回退分层 2D），以及原来分散在 `MascotDriver` /
> `MascotAIBridge` / 语音桥里的决策（`driver.ts`：口型与说话姿态、流式情绪、结尾去重、保持姿态的释放）。
>
> - 输入：`AvatarCharacter`（manifest 的引擎字段 + mapping，类型来自 `character-contract`）、`resolveAsset(path)`、
>   `AvatarEventSource`（语义事件：`speaking` / `cue` / `reply` / `emotion` / `gesture` / `voice` / `cursor` / `physics`）；
>   输出：`onInteraction`（click / double / pat / hover / grab / land / wall，带区域与台词 key）与可选的
>   `AvatarWindowHost`（命中、拖拽、身体框、Linux 窗口形状）。Rive wasm URL、就绪打点、开发态调试句柄由宿主传入，
>   包里没有 Vite 专用 import、`process.env` 或 `@nomi-ai/ui`；互动设置经 `setInteractionConfigBackend` 推给宿主；
> - 边界：eslint（`eslint.config.mjs` 的 avatar-runtime 块，error）禁止 import `contract` / `ai-sdk(-client)` / `host-*` /
>   `core` / 视图包 / `ui` / `services/api` 与访问宿主全局；`tests/boundary.test.ts` 再查 package.json 依赖与动态加载；
> - renderer 只留透明窗口壳、气泡、工具栏、右键菜单与适配层：`src/avatar/`（事件中枢 `avatarEvents`、契约窗口宿主、
>   互动输出 → `mascot:say` 与朗读、当前角色 → `AvatarCharacter`），`MascotDriver` / `MascotAIBridge` / 语音桥 /
>   拖入文件只把契约与本地事件翻译成语义事件；`mascot.command` 的动作 / 表情也走事件源；
> - 单独运行（完成标准；仓库没有 Storybook，不引入）：`pnpm --filter @nomi-ai/avatar-runtime demo` 是 Vite 开发页，
>   默认加载 `characters/test-dummy`（`AVATAR_DEMO_PACK=characters/nomi` 换官方包），假事件源 + 互动日志；
>   `tests/runtime.test.tsx` 在 happy-dom 里用替身包和假事件源挂载、驱动、卸载运行时（工作区没有 jsdom，用已有的 happy-dom）；
> - 行为不变：e2e-headed 的 E1、E5、E9、E11、E12、E15、E22、E23 在 macOS 上通过；看板娘首屏 JS 没有变大。
>
> 剩下的：
>
> - `characterVoice` 仍在 renderer：它是宿主朗读链路（预录片段、实时朗读经契约、静音状态、角色文案）的角色语音偏好，
>   运行时只经 `onInteraction` 报出「这句要朗读」；`lipSyncStore` 也留在 renderer 汇总 TTS 包络，消费在运行时；
> - `mapping.json` 只传进运行时、还没用（C3 按它翻译情绪 / 活动 / 手势，并把工具与 preset 改名）；
> - 运行时仍是全局单例（后端注册表、`layoutStore`、互动设置、自动动作冷却），同一页面只挂一个角色；多角色前要改成实例；
> - `InteractionLite` 在 window 上以捕获方式监听 `blur`，元素失焦（例如先点了别的按钮）也会取消一次按下（原有行为，
>   独立开发页里能看到）；
> - 动作显示名的翻译检查与 `docs/features/mascot.md` 对照留在 renderer 测试（`motionDocs.test.ts`），运行时不依赖 `ui`。

> P3 与 C2 合流（`refactor/c2-avatar` 变基到 `refactor/p3-core` 后快进合入，`refactor/p3-core` 同时包含两条线）：
>
> - 冲突只在 ESLint 与文档：`eslint.config.mjs` 里内核块与 avatar-runtime 块并存（内核块本来就禁止 import
>   `@nomi-ai/avatar-runtime`）；架构文档的包表在新表（`core` / `host-electron`）上加 avatar-runtime 行、换 renderer 行；
>   本节两份进度说明与阶段表合并（P3 行用 P3 的，C2 行用 C2 的）；锁文件自动合并，`pnpm install --frozen-lockfile` 通过；
> - 顺手改的：`core/src/mascot/mascotSize.ts` 注释指向 `avatar-runtime/src/spriteLayout.ts`（C2 留下的路径问题）；
>   AGENTS.md 包表加 avatar-runtime 行；e2e-headed 的 E19 改从 `packages/core/tests/fixtures/history` 读历史样例
>   （P3 第二步随 CLI 模块搬走，原路径已不存在）；
> - 验证：构建、typecheck、lint、单测（只有 `changesets.test.ts` 已知的 6 个失败）、无界面 e2e、i18n、许可、格式（只有
>   已知文件）通过；macOS 上 e2e-headed 跑了一整轮，看板娘与启动相关（E1、E4、E5、E9、E11、E12、E15、E22、E23、E30）
>   与对话（E2、E6、E16、E18、E24、E28）通过。
>
> 剩下的：
>
> - e2e-headed 里有几条与这次合流无关、看起来是用例落后于界面的失败：E19（历史会话行现在有删除按钮，用例断言没有）、
>   E25 A / B 与 E29（编程助手标签页的重新生成 / 重试与空闲回收）、E27 A（`/model` 卡片）；`IMAGE.theme` 还在调用已删除的
>   `registerIpc` 与 `dist/theme`、`dist/chat` 旧路径（P1b 起就跑不通）；`A11Y.surfaces` 单跑通过、整轮偶发失败。
>   这些没有在合流前的基线上复跑确认，要在 Linux + xvfb 的完整一轮里一起处理。

> P3 评审修正（`refactor/p3-core`）：
>
> - 改包名为 `@nomi-ai/host-electron` 时把运行时应用名也改了。Electron 用打包后 `package.json` 的 `productName`（没有则
>   `name`）作 `app.name`，userData 目录（`<appData>/<app.name>`）与 macOS 钥匙串里 safeStorage 的服务名 / 账户名都由它
>   决定；electron-builder 的 `productName: Nomi` 只管安装包、`.app` 与窗口名，不写进打包后的 `package.json`。原来的
>   进度说明说打包产物不受影响，是错的：已安装的 2.0.x 用户升级后会看到空配置（设置、网关、供应商、会话、记忆、知识库），
>   已存的 API Key 也解不开；更新缓存目录（`<name>-updater`）与 NSIS 的 `APP_PACKAGE_NAME` 也会变。
>   `electron-builder --dir` 从全新目录启动，发现不了；
> - 修正：`packages/host-electron/package.json` 加 `productName: @nomi-ai/electron`（Electron 运行时，开发态与打包后），
>   `electron-builder.yml` 的 `extraMetadata` 加 `name: '@nomi-ai/electron'`（electron-builder 自己用的包名）；开发态目录也
>   不变，`legacyUserData.ts` 去掉上一步加的 `@nomi-ai/electron` 迁移项（复制过去的目录在 macOS 上也解不开钥匙串里的
>   密钥）；`scripts/__tests__/electron-builder-app-name.test.ts` 守住这两个名字；重新 `electron-builder --dir` 后读 app.asar
>   里的 `package.json`，`name` 与 `productName` 都是 `@nomi-ai/electron`；
> - 文档对齐代码：§3.2 的 `core` 行补上实际依赖（`types`、`cli-plugins`、`bundle-ig-base`、`bundle-ig-mascot`），§10.6 写明
>   `characterVoice` 留在 renderer，§12.1 的命令与路径改成 `host-electron`，§13.1 的 userData 风险改成现在的做法。

> P4 第一步完成（分支 `refactor/p4-host-node`）：内核组合根 `createCore`（§7.1）落地，P0 的两个白名单清空。
>
> - 组合根拆开：`packages/core/src/createCore.ts` 建配置、界面语言、角色包与人设、各业务服务、AI runtime、应用契约的
>   router 与事件桥，返回 `{ ports, logger, events, config, container, services, router, start(), startReminders(),
stop() }`；宿主 `packages/host-electron/src/host/Application.ts`（宿主区域，可以 import electron）只建 Electron 端口与日志、
>   调 `createCore`、挂 IPC 传输与拖入文件通道，管窗口、托盘、灵动岛、`chat-asset://`、CSP、会话权限、应用事件与进程信号；
>   主题 → 标题栏、启动偏好 → 看板娘显隐与「关闭主界面时退出」、首次引导开窗口在 `core.start()` 之后由宿主接上。启动顺序：
>   app ready → `core.start()`（含 AI runtime 与 router）→ 挂 IPC → 建窗口 → `core.startReminders()` → 托盘，与原来一致；
>   配置改在 `core.start()` 里加载（原来在 ready 之前），macOS 首次启动的 `activate` 在 `start()` 走完前不再建窗口；
> - 宿主片段：传进 `createCore` 的 `contract.hostHandlers`，不由宿主在外面合并（理由见 §7.1）。内核实现 coding /
>   knowledge / media / shell 与 D5 里不碰窗口的部分（角色包、人设、聊天背景、模型名、`window.platform`）；宿主片段只剩
>   看板娘窗口互动与大小（`mascot.*`）、灵动岛（`island.*`）、旧窗口通道（`window.*`）与应用图标（`appIcon.*`）。
>   `nav.openVoiceSettings` 改走 `ports.windows.open('chat', { route: 'voice' })`；语音会话随窗口释放经
>   `ports.windows.onCallerClosed`，流式识别会话表在 `VoiceService` 里、临时结果经 `VoiceStreamSink` 推进发起方的流（§6.2）；
> - 搬进内核的业务：`ai/AIRuntimeBoot`（按内核实例 `new AIRuntimeService`，不用 ai-runtime 的模块级 `runtime`；网关 /
>   用量 / 扩展 / 人设在调用时从服务表读；宿主插件 `FileSessionStorePlugin` 与系统 TTS 由宿主经 `aiPlugins` /
>   `ttsProviders` 注入）、`core/BootstrapManager`（纯 Node 的启动任务调度，宿主用它排自己的启动任务）、契约处理函数
>   `media` / `shell` / D5 的内核部分与组装（`contract/router.ts`）。留在宿主：`ai/TtsElectronNativeProvider` 与
>   `services/AdvancedTTSEngine`（系统 TTS，读 `process.resourcesPath`、只在宿主有意义）、`utils/ErrorHandler`（装进程级的
>   `uncaughtException` / `unhandledRejection` 处理、决定退出进程，一个进程只能有一份，不属于内核实例）；
> - 模块级单例：各服务的 `init*` / `get*Service`、`getDesktopService` / `getVoiceService` / `getUpdateService` /
>   `getCharacterPackService`、`get/setPersonaService`、`eventBus`、`serviceContainer`、看板娘推送出口
>   `setMascotAppEvents` 与存活窗口数 `setMascotLiveWindows` 全部删除，没有保留的 `get*()`；宿主灵动岛的
>   `initIslandService` / `notifyIsland` 也删了（组合根持有实例）。服务经自己的 `events` 发看板娘指令
>   （`sendMascotCommand(events, cmd)`），看板娘窗口控制器与托盘由宿主传入内核的事件总线；桌面工具与看板娘的 AI 插件改成
>   工厂（`createDesktopIgPlugins` / `createMascotIgPlugins`）；窗口管理器的退出请求改成 `requestQuit` 回调；
> - 端口补了 `shell.trashItem`（删除历史会话移到废纸篓；`host-node` 只记录）；ai-runtime 的加载守卫不再要求
>   `process.versions.electron`，只拒绝渲染进程与页面（内核在纯 Node 里也要能加载它）；
> - `bundle-ig-electron-caps` 的 `electronLoader` 删除：剪贴板、截屏、全局快捷键、safeStorage 与 userData 目录都由宿主在插件
>   配置里注入，没注入时插件只记 warn、不提供能力。生产只用到 `FileSessionStorePlugin`，宿主传 `rootDir`；
> - 白名单：`ELECTRON_IMPORT_ALLOWLIST` 与 `ELECTRON_DYNAMIC_ALLOWLIST` 都是空的；
> - 验收：无界面 e2e 的 E6（`e2e/tests/E6.core-twice.test.ts`）在同一进程里用 `@nomi-ai/host-node` 的端口起两个内核，
>   断言服务实例、事件与 router 互不相干（一个内核改主题，另一个的服务与订阅者都看不到）、没有宿主片段时窗口过程
>   UNAVAILABLE、`stop()` 可重入。内核构建成 CommonJS，用例按 CommonJS 加载契约的客户端，避免两份 `ContractError` 类。
>   这个用例放在 Vitest 的无界面 e2e 里而不是内核的 Jest：ai-runtime 的 CommonJS 产物 `require` 纯 ESM 的 AI SDK，
>   Jest 的模块系统加载不了；
> - 验证：构建、typecheck、lint、单测（只有 `changesets.test.ts` 已知的 6 个失败）、无界面 e2e、i18n 通过；macOS 上
>   e2e-headed 跑了 E1、E4、E5、E16、E17、E30。
>
> 剩下的：
>
> - 界面语言、日志开关、私有文件根目录与诊断日志写入器已改为每个内核一份（2.0.5：`core/scope.ts` 的 `CoreScope`，
>   `createCore` 用 AsyncLocalStorage 把构造、启停与每个契约处理器包进本内核的作用域；宿主经 `core.i18n` 拿翻译函数）；
>   作用域之外 `t()` 用不可变的进程默认（`CD_LOCALE` 或中文）。仍是进程级的：子进程 / worker 的缓存
>   （`codexThreadReader`、`sileroNode`、CLI 路径探测、登录 shell 的 PATH）以及 `createMainLogger`；
> - `ai-runtime` 的 `package.json` 仍把 `bundle-ig-electron-caps` 与（可选的）`electron` 列为 peer（源码已不引用）；
> - 契约包同时发 ESM 与 CommonJS，同一进程里可能有两份 `ContractError`：服务端与客户端按 `name` / `code` 识别
>   （`isContractError`，见 P4 第二步），内核抛的业务码不会变成 INTERNAL；
> - P4 本身（`e2e/` 改跑无界面宿主、WebSocket 传输，§11.3 前两项）未开始。

> P4 第二步完成（分支 `refactor/p4-host-node`）：§11.3 前两项通过，P4 完成。
>
> - 无界面宿主：`@nomi-ai/host-node/core` 的 `startHeadlessCore()` 用 `createNodeHostPorts` 的端口（临时目录、内存密钥、
>   记录下来的对话框 / 通知 / 窗口调用）建内核并 `start()`，`connect(caller?)` 经 in-process 传输给出类型化的契约客户端
>   （一个连接 = 一个窗口，缺省 `{ surface: 'chat', trusted: true }`），`stop()` 停内核、断连接、先写完日志再删临时目录。
>   内核加了两个宿主选项：`CoreHostHooks.aiPluginsAfter`（宿主插件装在内置插件之后，后 provide 的覆盖前面的）与
>   `CoreConfig.gatewayPort`（统一网关本次运行的端口，不写回设置；无界面内核缺省 0，不和本机装着的 Nomi 抢 18721）。
>   `processes: true` 时工具子进程用 Node 子进程（`forkUtilityProcess`：`node -e` 引导，经 IPC 在子进程里补上 Electron
>   约定的 `process.parentPort`，结构化克隆），统一网关与文档解析在无界面宿主上也能起来；
> - `e2e/` 改跑无界面宿主：E1、E2、E4、E5 起真实内核（`createCore` + 生产的插件宿主与 `AIClient`），视图侧的
>   `ClientAIClient` 经 in-process 传输连进来；探针插件（`aiPluginsAfter`）换上假 LLM、往真实工具表里加测试工具、
>   拿插件上下文发插件事件。原来的假运行时（`e2eRuntime` / `rendererIpc` / `fakeSdkCtx`）删除。`e2e/setup/isolateEnv.ts`
>   把 HOME、PATH 指到空目录、去掉环境变量里的供应商 Key。E6 改用 `startHeadlessCore`，断言两个内核的服务、事件、
>   router、AI runtime 与数据（主题、用户画像、网关供应商（Key 不以明文落盘）、记忆）互不相干；E7 经 WebSocket 传输测
>   真实内核（握手、查询、修改、事件订阅、错 token / 外站 Origin 被拒绝）。全部用例不需要 Electron 与 xvfb；
> - 用真实内核跑出来的问题（都修了）：契约包与 `bundle-ig-base` 同时发 ESM 与 CommonJS，同一进程里两份副本互不相认——
>   `ContractError` 改为按名称与错误码识别（`isContractError(err, code?)`，不用 `instanceof`，跨副本、跨 realm 都认得），插件服务键改用 `Symbol.for('nomi.ig.service:<名字>')`
>   （上一步「剩下的」里的格式问题就此解决，E6 不再需要按 CommonJS 加载契约）；`UserPreferenceMemoryPlugin` 发的
>   `userProfile/changed` 是裸画像，与声明的 `{ profile }` 不符（视图侧两种都认，界面上没有变化）；`ai-sdk-client` 的主入口与
>   `react` 入口各打包一份共享传输表，Electron 里每个窗口其实开了两个会话（表改放 `globalThis`）；
> - WebSocket 传输：视图侧 `createWebSocketClientTransport`（`@nomi-ai/contract`，不依赖 Node 内置模块）；服务端
>   `serveContractOverWebSocket`（`@nomi-ai/host-node/websocket`，`ws`，MIT，内核原来就依赖）。只监听回环地址，校验 Host
>   （防 DNS rebinding）、Origin（完全匹配允许清单，没有 Origin 也拒绝）、子协议里的一次性 token（`createDevToken()`，
>   32 字节随机数，`timingSafeEqual`，日志只露前 4 位）与界面（`nomi-surface.<surface>`，dev:web 只放 chat），通过后
>   caller 记为 `{ surface, trusted: true }`；普通 HTTP 回 426，只收文本帧，单条消息与连接数有上限。每个连接一个
>   `createServerSession`，与 Electron IPC / in-process 共用帧处理；断开后不重连（开发态内核重启后刷新页面）；
> - 视图在浏览器里：ai-chat 的 `services/api.ts` 仍是唯一选传输的地方——有 preload 桥（`window.nomiTransport`）用它；
>   没有桥、且是开发构建（`import.meta.env.DEV`）并且开发服务器注入了 `window.nomiDevTransport`（只有地址；token 来自地址片段
>   `#nomi-token=…`，存 sessionStorage 后从地址栏抹掉，见 `resolveDevTransport`）时，用 WebSocket 传输并经
>   `installSharedTransport` 换掉窗口共享的传输（模块加载时就建好的客户端也跟着走）。§11.1 的 lint 规则加上新全局与
>   `createWebSocketClientTransport` / `installSharedTransport` 等工厂，只有 `services/api.ts` 能用；
> - 开发入口：`pnpm dev:web`（`scripts/dev-web/start.mjs`）在 Node 里用无界面宿主起内核（网关在 Node 子进程里），挂 WebSocket
>   传输，再起 ai-chat 的 Vite 开发服务器（自己一个进程组，停的时候整组停）；Vite 插件（`scripts/dev-web/vite-plugin.mjs`）
>   只在开发服务器、且拿到地址的环境变量时把地址注入页面（token 不进页面，只在终端打印的地址片段里），同时把开发服务器的 CORS 收紧到自己的地址；构建时
>   产物里出现 WebSocket 传输（子协议标记或全局名）就让构建失败——生产构建里 `import.meta.env.DEV` 为 false，这段代码与
>   传输一起被摇掉，打包的 Electron 应用里没有 WebSocket 路径（去掉 DEV 判断构建确实失败）；`host-electron` 不依赖
>   `host-node`；
> - 证明：Vitest 的 E7（真实内核）与 `host-node`、`contract` 的单测（安全检查逐项：错 token、外站 / 缺失 Origin、外站
>   Host、未知界面、错路径、缺协议、非回环绑定、二进制帧）；`pnpm smoke:web`（`scripts/dev-web/smoke.mjs`）用 Playwright 的
>   Chromium（不是 Electron）打开 ai-chat 开发页：页面渲染、没有 preload 桥、调用经 WebSocket 到内核（内核侧中间件记录）、
>   内核预设的主题与语言出现在页面上、内核换主题后页面跟着变，再在页面里走完首次引导（添加指向本机假上游的供应商、选
>   模型）并发一条消息，回复经统一网关回到页面。CI 的 e2e-headless 在 Linux 上追加这个冒烟；
> - 验证：构建、typecheck、lint、单测（只有 `changesets.test.ts` 已知的 6 个失败）、无界面 e2e（6 个文件 / 16 个用例）、
>   i18n、许可、`pnpm smoke:web` 通过；macOS 上 e2e-headed 的 E1、E5、E16、E17 通过（E16 第一次失败是因为另一个工作区的
>   Electron 占着 18721，那个进程退出后通过）。
>
> 剩下的：
>
> - 仍是进程级的子进程 / worker 缓存与 `createMainLogger`（见第一步的「剩下的」）E6 不断言；
> - 只有 ai-chat 接了 WebSocket 开发传输；看板娘窗口（renderer）是透明窗口壳，依赖宿主窗口，没有接。`dev:web` 里要用
>   窗口对象的过程（看板娘大小、灵动岛、应用图标、旧窗口通道）报 UNAVAILABLE，拖入文件（`nomiHost`）不可用；
> - 无界面宿主的资源目录是空的：角色包解析不到内置包（日志「built-in pack not found」，人设为中性），替身角色验收
>   （§11.3 第三项，G5）仍归 C3；`image` 端口没有实现，背景图不缩放；
> - e2e-headed 的用例都要 Electron，不能搬到无界面宿主：透明置顶的看板娘窗口与命中区、拖拽与窗口位置、托盘、灵动岛、
>   preload 与 `nomiHost`、系统对话框、全局快捷键、窗口截图（UI、ANIM）、打包产物的生产模式冒烟（E5）；
> - `ai-runtime` 的 `package.json` 仍把 `bundle-ig-electron-caps` 与（可选的）`electron` 列为 peer（源码已不引用）；
> - WebSocket 传输按开发态设计（一次性 token、没有重连、没有会话恢复），作为 sidecar 宿主的生产传输前要补：重连与
>   订阅恢复、token 的下发方式（不经页面全局）、调用者身份细分（目前一律 trusted）。

> C3 基本完成（分支 `refactor/c3-semantic`，从 `release/2.0.5` 的 `56cfbd84` 起）：AI 与角色之间只传语义事件（§10.5），工具与 preset 改名。
>
> - 词表：`character-contract` 的 `SEMANTIC_EMOTIONS`（加 `relaxed`）、`SEMANTIC_ACTIVITIES`、`SEMANTIC_GESTURES`（扩到 AI 侧原来会发的全部：
>   `avatar_gesture` 说明里列的 42 个动作名、内核服务、托盘、表情导演用到的，共 46 个，含 `random`），与 `contract.json` 同步；
>   保留目标 `MAPPING_RESERVED_TARGETS = ['random']`；manifest 加 `capabilities.expressions`，`validatePack` 的情绪目标对它查、
>   活动 / 手势目标对动作查；
> - 映射：`characters/nomi/mapping.json` 覆盖全部手势与 `thinking` / `toolRunning`，情绪映射 2.0.5 已有的六个表情
>   （`shy` / `confused` / `sleepy` 没有对应表情：以前 `avatar_emotion` 直接拒绝，现在忽略）；目标就是原来到达后端的那个名字，
>   `avatar-runtime/tests/mapping.test.ts` 逐个核对旧名与新目标在 Rive 与分层 2D 上落到同一个片段。`reachOut → interact` 是引擎别名、
>   不在 manifest 声明的片段里，`character:check` 给一条警告，为了行为不变保留。`characters/test-dummy/mapping.json` 只映射 `neutral`；
> - 运行时：`mapping.ts`（`setAvatarMapping`、`emotionTarget` / `gestureTarget` / `activityTarget`、`DEFAULT_AVATAR_MAPPING`）。没有
>   `mapping.json` 的包用默认映射（= 官方包，测试保证一致），有的只按它来，没映射的忽略；表情导演、语音状态、流式情绪只给语义名
>   （`ExpressionDirective.gesture` / `activity`），经映射落到资源；输入事件加 `emotion(name, weight)`、`activity(name)`、
>   `reply(waiting / settled)`（对话窗口等回复，原来的 `think-on` / `think-off`，仍是分层 2D 的引擎控制）；输出 `onAvatarEvent`：
>   `touched` / `clicked`（摸、点、双击，按互动冷却过滤后）与 `scene`（挂载或换角色时：角色 id 与有映射的语义名）；
> - 契约（major 升到 2：`ai.avatar.*` 改名，不留旧名）：`ai.avatar.{emotion,gesture,activity,speaking,report}`，事件
>   `ai.avatar.{touched,clicked,scene}`；看板娘域新增事件 `avatar.event`（只给看板娘窗口）；`mascot.command` 只剩 `open-panel` /
>   `say`（带语义 `gesture`）/ `reply-speech`；`onboarding.mascot` 只收 `say` / `gesture` / `reply`；语义名的 schema 只收驼峰，
>   `thumbs_up`、`think-on` 这类资源名过不了线。`character.getActivePack` 多了 `mapping`，覆盖包的映射传到运行时；
> - AI 侧：`bundle-ig-mascot` 的 `ctx.avatar` 改成语义接口（`emotion` / `gesture` / `activity` / `speaking` / `report` /
>   `on('touched' | 'clicked' | 'scene')`），词表外的名字忽略；工具 `avatar_gesture { name }`、`avatar_emotion { name, weight? }` 的
>   入参是词表枚举；`ai-sdk` 的 `AvatarFacade` 同形；内核服务（桌面、日程、记忆、知识库、扩展、本地模型、编程助手进度）经
>   `avatarGesture(events, …)` / `avatarEmotion(events, …)`（内核实例自己的事件总线）发 `avatar:event`，托盘「动作」菜单发语义手势。`scripts/__tests__/avatar-semantic-names.test.ts`
>   扫内核、AI 运行时 / SDK、插件包与契约的源码，不得出现片段 / 动作资源名（取自 `contract.json`）；
> - 改名（不留别名）：`WaifuToolsPlugin` → `CompanionToolsPlugin`、`WaifuAgentPresetPlugin` → `CompanionAgentPresetPlugin`（preset
>   `companion`）、AI runtime 缺省 profile `companion`、renderer 的 `Waifu*` 组件与 `useWaifuMessage`、DOM id `waifu-*`，以及 e2e /
>   e2e-headed 的 E1、E4 文件名与 harness 的缺省 profile。preset id 没有落盘：会话的 `agentPreset` 由内存版 `SessionFacade` 保存，
>   profile 来自启动参数 / 环境变量 `IG_AI_PROFILE`，没有要迁移的用户配置；renderer 只写不读的 localStorage 键 `waifu-display` 改名；
> - 三个没装载的插件：`TtsLipSyncPlugin` 删除（口型由看板娘窗口本地的 TTS 包络 → `speaking` → avatar-runtime 驱动，主进程 host 的
>   `driveLipSync` 本来就是空操作，它的 `tts/end → playMotion('idle')` 也是资源名）；`TouchInjectPlugin` 删除（它发的
>   `agent/sensory-inject` 全仓库没有订阅者；触摸现在是语义事件 `touched`，经 `ai.avatar.report` 到 `ctx.avatar.on('touched')`）；
>   `WaifuAgentPresetPlugin` 改名并接入 `mascotIgPlugins`（P0 为它做了 `PersonaIdentityPlugin`，替身验收测试读的也是它的系统提示；
>   它是 `companion` preset 与语义工具白名单的归属）；
> - 行为不变：Nomi 的动作、表情与音效和以前一致（对话等回复时的那一声轻响也保留）。去掉一处：renderer 订阅 `avatar:touch` 显示
>   「摸到…了」气泡，以前没有发布方；现在触摸真的报给主进程，再显示会与互动反应的台词重复，删掉（含 i18n key）。e2e-headed 的
>   E1、E2、E4、E5、E9、E10、E11、E12、E15、E16、E22、E23、E30 在 macOS 上通过。
>
> 剩下的：
>
> - §11.3 替身角色（G5）没有达成：替身包有了映射，运行时与内核的单测走真实路径（人设、系统提示身份段、发给界面的快照不含官方名），
>   但用它跑一轮 e2e、断言界面文本不含 Nomi，要先做界面文案里产品名 / 角色名的分拣（§10.1）与 `scripts/check-character-leak`（§11.2）；
> - `companion` preset 已注册，还没有消费方：对话的默认系统提示由内核拼（`core/src/persona/systemPrompt.ts`，契约 `persona.systemPrompt`，2.0.5 起；原来在 ai-chat 的 `IPCClient`），会话的 `agentPreset` 只是透传字段；
> - `touched` / `clicked` / `scene` 到了 `ctx.avatar`，还没有 AI 功能订阅（例如把触摸作为感官输入注入会话）；
> - 互动反应表（`interaction/gestures.ts`：摸头、点击等）仍直接用引擎动作名、不经映射：这是角色对用户操作的反应，不来自 AI；
>   看板娘窗口的动作菜单列的也是当前后端的动作（资源名，直接交给引擎）。

> G5 完成（分支 `refactor/c3-semantic`，接在 C3 之后）：§10.1 的产品名 / 角色名分拣、§11.2 的名字扫描、§11.3 第三行的替身验收，以及 C1 后续里剩下的几条。
>
> - 产品名：`@nomi-ai/types` 的 `brand`（`appName: 'Nomi'`、`appId`）是唯一来源，`host-electron/src/brand.ts` 只转出它，删掉
>   `APP_DISPLAY_NAME_ZH`；窗口 / 灵动岛标题、托盘提示、侧栏 / 标题栏 / 设置页 / 看板娘面板的品牌字样、日程通知标题、各处端点名「Nomi」
>   都用 `brand.appName`；`scripts/__tests__/brand.test.ts` 守住 `electron-builder.yml` 的 `productName` / `appId` 与它一致。设置页品牌头
>   从「Nomi · 诺米」改为「Nomi」。句子里的产品名（「Nomi 对话」「Nomi 网关」「退出 Nomi」）保留字面量：词序由翻译决定，扫描只拦角色语境；
> - 角色名：指桌面上那个角色的文案（「显示 X」「桌面 X」「X 已隐藏」「X 工具栏」「关闭 X」「你好，我是 X」等约 25 条）改为带 `{0}`，
>   填当前角色的人设名（当前界面语言）：ai-chat 经 `services/characterName`（契约 `persona.get` / `persona.changed`），renderer 经
>   `mascot/characterCopy.characterName()`（覆盖包快照的 `displayName`，否则内置包人设），托盘经 `PersonaService`；拿不到时用通用称呼
>   「看板娘 / Mascot」。「她 / her」改成中性写法；
>   不需要名字的改成通用说法（「诺米提示语音」→「角色提示语音」、朗读打断、预算提醒的「看板娘气泡」、活动记录的「拖入文件总结」）；
> - 角色名分全名与简称（修正，docs/BRAND.md）：「Nomi·诺米」是一个完整的名字，界面上不单独写「诺米」。人设加 `shortName`
>   （官方包 `displayName`「Nomi·诺米」、`shortName`「Nomi」；缺省同 `displayName`，见 `personaNames`）；欢迎语用全名
>   （`characterFullName`），其余用简称（`characterName`），句子经 `tName` 拼名字、中文里名字与汉字之间补空格（`spaceAround`），
>   官方构建的这些文案与 2.0.5 一致（「显示 Nomi」「你好，我是 Nomi·诺米」）。发给模型的身份句不变（测试钉住）。
>   `check:character-leak` 还扫官方包里单独的「诺米」，例外（唤醒词、身份句、预录合成输入）写在 `BARE_ALLOW`；
> - 角色文案进角色包：带名字的自我介绍（原 `ui.cli-monitor.hi-i-m-nomi`、`ui.voice-mascot.hi-i-m-nomi-let-s-do-our`）改为角色台词
>   `greet-hello` / `greet-lets-go`（id 就是原来的预录片段 id），写进 `characters/nomi/locales` 与替身包，全局词典删掉这两条；
>   语音设置「试听」念 `greet-lets-go`，包里没有就念 `greet-companion`；
> - 唤醒词：默认值不再写死「你好，诺米」，存的为空时用当前角色包主语言的 `wakePhrase`（`CharacterPackService.wakePhrase()` →
>   `VoiceDeps.defaultWakePhrase`，不写回磁盘，换包跟着变）；用户自己存过的唤醒词照旧。`character.getActivePack` 的 `locales` 多带
>   `wakePhrase`，契约 schema 同步声明（版本 2.1，只加字段）——C1 后续里「get-active 的身份字段进契约」这条：`id` / `mode` /
>   `displayName` / `locales` 在 P1b 已声明，这次补齐 `wakePhrase`；
> - Rive：`getRiveConfig` 不再回退到官方画板名（`Nomi-full` / `NomiFull`），包没写就用 .riv 的默认画板与状态机；
> - 名字扫描（§11.2）：`scripts/check-character-leak.mjs` + `scripts/lib/characterLeak.mjs`，`pnpm check:character-leak` 进 CI 与 AGENTS.md
>   命令表，单测 `scripts/__tests__/check-character-leak.test.ts`（规则正反例、扫描范围、允许清单必须有理由且必须命中、仓库本身通过）。
>   注释里的「诺米」也一起改掉了，所以规则可以简单：扫到就算；
> - 替身验收（§11.3 第三行）：`e2e/tests/E8.stand-in-character`（无界面；变基到 P4 之前是 E6，跑在假运行时上）在无界面宿主的真实内核上
>   按 `CHARACTER_PACK` 解析出 `characters/test-dummy`，经内核自己的 `CharacterPackService` → `PersonaService`，ai-chat 真实的
>   `SdkIPCClient` 经契约取人设、发到内核的 AI 路由，断言模型收到的系统提示、
>   `companion` preset 的身份段、人设与角色包快照都是替身、没有官方名；`e2e-headed/tests/G5.stand-in-character`（真实应用，只在替身构建上跑，
>   官方构建上跳过）走首次引导每一步、配好本地 mock 供应商后对话、设置 → 通用与看板娘窗口，界面文本（含 aria-label / title / alt）不含
>   官方角色名、该写角色名处是「小纸」，mock 收到的系统提示是替身身份。构建开关：`pnpm build:stand-in`（=
>   `CHARACTER_PACK=characters/test-dummy pnpm build`，跨平台），见 `docs/development/testing.md`；
> - `examples/static-demo.pack` 换成新布局（命中区进 `manifest.layout`，`persona.json` + `locales/`），`character:check` 只剩缺语音的警告。
>   旧布局的迁移读取保留：2.0.x 的第三方包可能还以旧布局放在用户磁盘上；改由 core `packResolve.test.ts` 的固定样例（与 character-contract
>   已有的旧包样例）守住，不再靠示范包；
> - 验证：构建、typecheck、lint、单测（只有 `changesets.test.ts` 已知的 6 个失败；全量并行时 ai-chat 的 `confirmDialog` 偶发超时，单跑与整包
>   重跑通过）、无界面 e2e（变基前：5 个文件 16 个用例）、i18n、许可、`check:frontend`、`check:character-leak` 通过；macOS 上 e2e-headed 的 E1、E4、
>   E5、E7、E9、E11、E14、E15、E16、E22、E23、E30、I18N、V111 在官方构建上通过，G5 在替身构建上通过。
>
> 剩下的：
>
> - `character-contract/contract.json` 的 `rive.artboard` / `stateMachine` 缺省值仍是官方画板名：内核给没写 `rive` 段的 rive 覆盖包补的就是它
>   （契约包的数据，不在扫描范围）。要不要改成「不填就用 .riv 默认」，等第三方 rive 包的模板定下来再决定；
> - 中文界面的角色语境从「Nomi」变成人设名「诺米」，与 `docs/BRAND.md`「中文首次写 Nomi·诺米、之后写 Nomi」的口径不同：品牌文档要按
>   「产品叫 Nomi，角色叫诺米」改写；
> - 界面里指代角色的人称来自角色包：`persona.json` 的 `pronoun`（中文）与 `locales/en.json` 的 `persona.pronoun`（英文主格），
>   没写时用中性的「它 / it」，不拿另一种语言的值顶替；官方包是「她 / she」。`character-contract` 的 `personaPronoun` /
>   `pronounForms` 给出宾格与所有格（ai-chat `characterPronoun()`），「点{1}的『AI 对话』」「打开{1}后」这类文案经参数传入；
>   其余不需要人称的文案改成不带人称的写法（「摸头、戳脸…」「除非你逐个文件夹授权，否则看不到你的文件」）；
> - 托盘菜单在建菜单时取一次角色名，换角色包 / 换语言后要等菜单重建才更新。

> P4 与 C3 / G5 合流（`refactor/c3-semantic` 变基到 `refactor/p4-host-node` 之上，再快进合入 P4 分支）：两条线都从 `release/2.0.5` 的
> `56cfbd84` 起、并行做完，合流时按 P4 的「每个内核实例自己的事件总线、没有模块级出口」改写 C3 的语义事件出口。
>
> - 语义事件的出口跟 `sendMascotCommand(events, cmd)` 一样带事件总线：`publishAvatarCue(events, cue)`、`avatarGesture(events, name)`、
>   `avatarEmotion(events, name, weight?)`，不再返回存活窗口数（C3 里靠模块级 `setMascotLiveWindows` 数窗口，P4 已删除）。首次引导的
>   `onboarding.mascot` 仍用 P4 的 `OnboardingDeps.liveWindows` 判断是否送达；托盘「动作」菜单用宿主传入的内核事件总线发语义手势；
>   `createMascotIgPlugins(events)` 装 `AvatarSeamPlugin`、`CompanionToolsPlugin`、`CompanionAgentPresetPlugin` 与按实例的
>   `MascotIpcHostPlugin`（语义事件经这个内核的事件总线发出）；`avatar:event → avatar.event` 进内核的事件桥（`core/contract/mascot.ts`），
>   宿主片段里不再有事件桥；
> - G5 里接在旧组合根上的两处改到新位置：唤醒词缺省值 `defaultWakePhrase` 在 `createCore` 建 `VoiceService` 时接
>   `services.characterPack.wakePhrase()`，托盘的角色名在宿主 `host/Application.ts` 读 `core.services.persona`；
> - 无界面 e2e 编号：P4 已有 E6（两个内核）与 E7（WebSocket），C3 的替身验收改为 `E8.stand-in-character`，从假运行时
>   （`e2eRuntime`，P4 已删除）改跑无界面宿主的真实内核：`CHARACTER_PACK` 给 `characters/test-dummy` 的绝对路径，无界面宿主的应用目录是
>   临时目录、没有构建产物，内置包就解析成替身（P4「剩下的」里「无界面宿主解析不到内置包、G5 仍归 C3」这一条就此对上）；人设经契约
>   `persona.get` 取，`companion` preset 从内核插件宿主里真实装好的 `AgentPresetRegistryKey` 取。新增 `E9.avatar-semantic-events`：
>   `ctx.avatar`、工具 `avatar_gesture`、视图的 `ai.avatar.*` 与 `onboarding.mascot` 都经内核事件总线到 `avatar.event`，只有看板娘窗口
>   收到（对话窗口订阅了也收不到）；`thumbs_up` 这类资源名在契约上被拒（`BAD_INPUT`）；看板娘窗口 `ai.avatar.report` 的 `touched` 到
>   `ctx.avatar.on('touched')` 与订阅了 `ai.avatar.touched` 的窗口。E1 / E4 按 C3 改名为 `companion`，假的 `AvatarService` 改成语义接口；
> - 验证见合流提交的说明（构建、typecheck、lint、单测、无界面 e2e、i18n、许可、`check:character-leak`、changelog、格式、浏览器冒烟、
>   macOS 上整套 e2e-headed）。
>
> 剩下的：
>
> - 界面语言、日志开关、私有文件根目录与诊断日志写入器按内核实例隔离（`CoreScope`，见 P4 第一步「剩下的」第一条）；仍是进程级的是
>   子进程 / worker 缓存与 `createMainLogger`；
> - 内置角色包是内核实例的选项（`CoreConfig.builtinCharacterPack`），不是进程环境变量：E8 给替身包的路径，同一进程里别的内核仍用官方包。

> 合流后的评审修正（`refactor/p4-host-node`）：
>
> - G5 把 `ui.usage-tools.nomi-size` 改成「{0}大小」后，看板娘工具栏的大小分组与右键菜单的大小菜单没传参数，读屏读出「{0}大小」：
>   两处改传 `characterName()`。`check:i18n` 加一条：`t()` / `tr()` 的参数比文案里的 `{0}` / `{name}` 少就报错（结果再手动
>   `.replace('{0}', …)` 或当模板交给别的函数的除外），把这次的两处拦下来了；
> - `pnpm dev:web -- --data .nomi-web` 的数据目录在仓库里，而无界面宿主的 `secrets` 只是可逆编码：`.nomi-web/` 进 `.gitignore`，
>   给了 `--data` 时启动打一条警告（数据目录里的密钥没加密）；
> - C3 之后覆盖包的 `mapping.json` 决定播什么，照 2.0.5 官方模板写的映射（情绪指向动作：`happy → nod`、`sad → tears`、
>   `surprised → surprise`、`confused → puzzled`、`sleepy → yawn`，只列了十几个手势）会让表情落回中性、没列出的手势不播。2.0.5 并不读
>   mapping.json，所以这类映射按旧行为处理：`character-contract` 的 `isLegacyMapping` 认出模板里这几对（包把那个名字声明成表情的不算），
>   validatePack 给 `mapping-legacy` 警告并不用它，运行时退回引擎默认映射；`setAvatarMapping` 也兜一次底。C3 的 changeset 补了这一条；
> - `check:character-leak`：其它角色包里任何 `Nomi` 都算泄漏（包里没有产品语境）；补了「Nomi is thinking」「Nomi says」「Pet Nomi」
>   「Nomi 正在 / 说 / 觉得…」「摸摸 Nomi」这类角色口吻（「对 Nomi 说」「让 Nomi 选」是对助手说话，算产品）；扫描范围加上
>   `packages/*/index.html` 与 `packages/*/public`。新规则查出定时面板「试一下」的预览「Nomi 说：「…」」是角色在说话，改成当前角色名；
> - `host-node` 的 WebSocket 用例在全量并行时偶发：关连接后固定等 20ms 不够，改成轮询到连接数为 0；
> - 验证：构建、typecheck、lint、单测（`changesets.test.ts` 已知的 6 个失败；一次全量并行里 core 的 `UpdateService.test.ts` 在 afterEach
>   删临时目录时 ENOTEMPTY，单跑与重跑通过）、无界面 e2e（8 个文件 24 个用例）、i18n、`check:character-leak`、changelog、`character:check`、
>   浏览器冒烟通过；macOS 上 e2e-headed 的 E11、E22、E23 在官方构建上通过，G5 在替身构建上通过。
>
> 剩下的：
>
> - `isLegacyMapping` 只认 2.0.5 模板里那几对；用户自己改过、情绪指向其它动作名的旧映射认不出来，仍按语义翻译（`character:check` 在包声明了
>   `capabilities.expressions` 时会给 `mapping-target-undeclared`）；
> - 角色口吻的正则是列举式的，新写法要在 `scripts/lib/characterLeak.mjs` 补；
> - core `UpdateService.test.ts` 的 afterEach 与未完成的异步写入有竞争（偶发 ENOTEMPTY），未处理。

| 阶段            | 内容                                                                                                                                                                                                             | 完成标准                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| P0 **已完成**。 | ① lint 护栏：`packages/electron/src` 中除宿主目录（§7.2 右列）外，新增 electron import 报错（已有的列入白名单，只减不增）；② `PersonaService`，删两处人设硬编码                                                  | 护栏进 CI；换皮后系统提示不再是 Nomi                                                                               |
| P1a             | **已完成**。建 `contract` 与 `defineContract`；AI 门面（35 个 `ai.*` 过程 + 12 个事件）上契约，取代两份 `channels.ts`；`ClientAIClient` 改走 `window.nomiTransport`                                              | AI 门面只经契约访问；两份 `channels.ts` 删除                                                                       |
| P1b             | **已完成**。其余 `ai:*` 服务通道与 `window.electronAPI` 的能力逐个进契约；视图改用 client；删除 `window.aiIPC` / `window.electronAPI`                                                                            | 视图中不再出现 `window.aiIPC` / `window.electronAPI`                                                               |
| P2 **已完成**。 | 建 `host-ports`；替换 `app.getPath`（10）、`safeStorage`（9）、`dialog/shell/clipboard` 等（15）；29 处窗口广播改为 `ctx.events.publish`                                                                         | `packages/electron/src` 中业务模块不再 import electron                                                             |
| P3              | **已完成**（P0 白名单在 P4 第一步清空，见上方进度说明）。物理搬家：业务模块 → `packages/core`；`packages/electron` → `packages/host-electron`（`@nomi-ai/host-electron`）；ai-runtime 的 Electron 适配器移入宿主 | 目录与 §3.3 一致；P0 白名单清空                                                                                    |
| P4              | **已完成**（见上方 P4 两步的进度说明）。内核组合根 `createCore`，同一进程可起多个内核；`host-node` + in-process / WebSocket 传输；`e2e/` 改跑无界面宿主                                                          | §11.3 前两项通过                                                                                                   |
| C1 **已完成**。 | `character-contract` 包；官方资产与人设集中到 `characters/nomi`；删 Scheme A 原地覆盖与两份 `character.generated.json`                                                                                           | 官方构建与白标构建走同一路径                                                                                       |
| C2              | **已完成**。拆出 `avatar-runtime`；renderer 只留窗口壳                                                                                                                                                           | avatar-runtime 能单独运行（开发页 `demo/` 与挂载测试；仓库没有 Storybook）                                         |
| C3              | **已完成**（见上方 C3 与 G5 进度说明）。语义事件协议 + `mapping.json`；工具与 preset 改名（不保留别名）                                                                                                          | AI 侧代码中不出现 clip / motion 名（扫描测试守住）；§11.3 替身角色通过（E8 / G5 替身 e2e，`check:character-leak`） |

- **P1a 的行为变化**：AI 门面的业务事件（`ai.agent.step`、`ai.tts.chunk`、`ai.userProfile.changed` 等）改由契约传输按订阅分发，**只推给订阅了该事件的窗口**；以前 `EventBroadcaster` 经 `ai:event` 通道广播给所有存活窗口（可选按窗口过滤），该通道已删除。没有经契约订阅的窗口（含直接监听 `ai:event` 的页面）收不到这些事件，P1b 迁移视图时要改成显式订阅；窗口导航或刷新后订阅随会话一起失效，由新页面重新订阅。
- **P1 与 P2 可以并行**：一个改视图一侧，一个改内核一侧，中间靠契约对齐。
- **C 线可以和 P 线交错**：C1 不依赖 P 线；C2 依赖 P1（avatar 事件要走契约）；C3 依赖 C2。
- 每个阶段都能单独合并、单独发版，中途停下也不会留下半成品状态。
- 用户可见的行为变化（工具改名、角色文案位置）需要 changeset；迁移本身没有用户可见变化，不加。

### 12.1 P1b 实施约定

五个域并行迁移，**每个文件只属于一个域**：

| 域  | 文件名（`<f>`） | 命名空间                                                                                                          | 主进程                                                                                                                                                        | 视图                                                                                                                                                                                                                                                                                                   |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | `media`         | `voice` `tts` `desktop` `screen` `nav`                                                                            | `voice/` `tts/` `desktop/` `screen/` `handlers/ipc/{ConfigIpcHandler,VoiceIpcHandler}`                                                                        | `voice/src/bridge.ts`；ai-chat `desktopClient` `ttsConfigClient` `replySpeech` `screenClient`；renderer `DesktopConfirm` `ReminderCard` `MascotAudioBridge` `useFileDropSummarize` `mascot/tts/*` `mascot/voice/promptClips` `mascot/openVoiceSettings` `services/VoiceService`                        |
| D2  | `shell`         | `theme` `locale` `startup` `onboarding` `providers` `gateway` `usage` `quality` `updates` `diagnostics` `appIcon` | `theme/` `i18n/` `startup/` `onboarding/` `gateway/` `usage/` `diagnostics/` `services/UpdateService` `core/appIcon` ai-runtime `providers/ProviderIpcServer` | `ui/src/{theme,i18n}.ts`；ai-chat `startupClient` `Onboarding/client` `providerClient` `gatewayClient` `terminalCommandsClient` `usageClient` `qualityClient` `diagnosticsClient` `nomiModel` `ReleaseNotesModal` `RestartUpdateButton` `UpdateSettings` `AppIconSettings`；renderer `mascot/presence` |
| D3  | `coding`        | `harness` `cli` `cliAccount` `cliUpdate` `delegate` `agents` `history`                                            | `cli/` `agents/`                                                                                                                                              | ai-chat `harnessClient` `cliPluginClient` `cliAccountClient` `cliUpdateClient` `delegateClient` `agentsClient` `historyClient`                                                                                                                                                                         |
| D4  | `knowledge`     | `kb` `mem` `sched` `local` `hub` `ext`                                                                            | `knowledge/` `memory/` `schedule/` `local/` `extensions/`                                                                                                     | ai-chat `kbClient` `memClient` `schedClient` `localClient` `extClient`                                                                                                                                                                                                                                 |
| D5  | `mascot`        | `mascot` `character` `persona` `island` `chatBg` `files` `window`                                                 | `mascot/` `island/` `chat/` `character/` `persona/` `ai/mascotCommand` `handlers/ipc/WindowIpcHandler`                                                        | renderer 其余用 `electronAPI` 的文件（`mascot/*` `SpriteMascot` `ToolBar` `MessageBubble` `utils/cache` `ai/*`）；ai-chat `IPCClient`（人设）`chatBackground` `fileAttachments` `Onboarding/artUrls` `IslandSettings` `MascotSizeSettings`、`main.tsx` 里读 `platform` 的那一行                        |

每个域可以改的：`contract/src/app/<f>.ts`（可另建 `contract/src/app/<f>/*.ts`）、`electron/src/host/contract/<f>.ts`
（可另建 `host/contract/<f>/*.ts`）、两个视图的 `services/hostBackends/<f>.ts`、上表本域的主进程与视图文件、
它们的测试。**不改**：`contract/src/app/index.ts`、`host/contract/{index,types,services,eventBridge}.ts`、视图的
`services/api.ts`、`core/Application.ts`、`ai/AIRuntimeBoot.ts`、preload、`packages/types` 的 `IpcApi`、
`security/`、eslint 配置与 `scripts/eslint/`、`e2e*/`、package.json / 锁文件、文档与 changeset。

1. **命名**：过程与事件都是 `<命名空间>.<方法>`，驼峰（`ai:kb:add-folder` → `kb.addFolder`，
   `ai:theme:changed` → 事件 `theme.changed`）；不用 `ai.` 前缀（留给 AI 门面），不用 `meta` / `on`。
2. **schema**：照现有 TS 类型写 zod；入参是具名对象（位置参数 `(id, enabled)` → `{ id, enabled }`）或
   `z.void()`；字段多、会演进的返回值与事件用 `z.looseObject`（未知字段透传，与原 IPC 一致），不用 `z.any()`；
   只用可序列化值（JSON + `Uint8Array`；时间用数字，不传 `Date` / `Map` / class / 函数）。
3. **kind**：只读用 query，有副作用用 mutation，原来按请求窗口推进度的可以改成 stream；没有同步调用。
4. **错误**：不再返回 `{ __error }` 信封，处理函数直接抛；需要视图走控制流的业务码在 `<f>Errors` 里声明
   （UPPER_SNAKE_CASE），用 `ctx.fail(code, message)`；服务缺失用 `need()`（`UNAVAILABLE`）。
5. **安全**：原来只在一个 preload 里暴露的能力写 `surfaces`（看板娘 `['mascot']`、对话窗口 `['chat']`；`aiIPC`
   两个窗口都有，不写）；回答用户确认、授予权限的过程写 `dangerous: true`（如 `desktop:confirm-answer`、
   `ai:harness:reply-permission`、`ai:desktop:grant`）。判定由契约内置守卫做，审计由 `auditMiddleware` 记。
6. **处理函数**：`create<F>Handlers(deps)` 每个过程一两行，委派给服务的公开方法；服务在调用时读
   （`need(deps.services.kb, 'kb')` 或已有的 `getXxxService()`）；需要发起窗口的用 `callerWebContentsId(ctx)`。
   **不删** `registerIpc()` 与旧处理器（e2e-headed 还在用，收尾批次删）；逻辑在 `registerIpc` 闭包里的，先抽成
   服务的公开方法，新旧两边共用。
7. **事件**：服务照旧 `events.publish(<旧通道>, payload)`，在 `<f>EventBridge` 里登记 `'<旧通道>': '<事件>'`
   （payload 要变形就写 `{ event, map }`）。直接 `webContents.send` 的改成经 `events.publish(…, { surface })`
   再桥接。契约事件只推给订阅了的窗口。
8. **视图**：本域的客户端模块内部改用 `import { api, hasTransport } from '…/services/api'`（`api.kb.addFolder({…})`、
   `api.on('kb.changed', fn)`），没有传输时走原来的本地退路；**导出的函数名、签名与返回形状不变**（别的域在用）。
   共享包（`ui`、`voice`）不 import 契约：在包里加注入点（`setXxxBackend`），在 `hostBackends/<f>.ts` 里接上。
   本域文件里用到别的域的能力：对方有客户端模块就经它调用，没有就保持原样并在汇报里列出，由收尾批次处理。
9. **测试**：契约 `contract/tests/<f>.test.ts`（过程名 / kind / surfaces / dangerous 快照，schema 接受与拒绝）；
   宿主 `host-electron/tests/unit/host/contract/<f>.test.ts`（P3 前在 `packages/electron`）（`createContractServices()` + 假服务 →
   `createAppRouter` 或 `createTestClient`，断言委派、FORBIDDEN、事件桥）；视图把 `window.aiIPC` 的 mock 换成
   `vi.mock('…/services/api')`，返回 `@nomi-ai/contract/testing` 的 `createTestClient(appContract, {…}).api`。
10. **构建**：视图与主进程读契约的 dist。改完契约后重建，并且与依赖它的类型检查一起放在锁里，避免并行时 tsup 清空
    dist：`node scripts/with-lock.mjs contract pnpm --filter @nomi-ai/contract build`、
    `node scripts/with-lock.mjs contract pnpm --filter @nomi-ai/host-electron typecheck`（P3 前包名是 `@nomi-ai/electron`）。

收尾批次（不属于任何域，已完成，见上文进度）：删 preload 里的 `aiIPC` / `electronAPI` 与 `packages/types` 的 `IpcApi`、各服务的
`registerIpc` 与旧处理器（及 `ProviderIpcServer` / `CapabilityIpcServer` / `AiChatCompat`）、事件桥里旧通道的广播；
e2e-headed 改走契约；lint 禁止视图访问 `window.aiIPC` / `window.electronAPI`（§11.1）。

## 13. 风险、取舍与待决

### 13.1 风险

| 风险                                 | 应对                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| P2 广播替换面广，容易漏掉事件        | 先在 `EventBroadcaster` 侧加「未声明事件」告警；契约事件表与实际 publish 做对照测试         |
| 契约序列化约束导致现有接口要改形状   | 先列出所有传函数 / 实例 / 同步调用的接口，P1 开工前评估                                     |
| 搬家（P3）冲掉进行中的分支           | 选在发版后的窗口一次性搬；用 `git mv` 保留历史；提前通知                                    |
| 改包名导致 userData 路径变化         | 运行时应用名固定为 `@nomi-ai/electron`（`productName` 与 `extraMetadata.name`），有回归测试 |
| 工具改名影响已保存的会话与外部提示词 | 已定不保留别名：历史会话里的旧工具调用只作展示，不重放；changeset 写明改名                  |
| WebSocket 传输带来新的本机攻击面     | 只在开发态和 sidecar 宿主启用；只监听 `127.0.0.1`；一次性 token；仍经 §8 中间件             |

### 13.2 待决

| #   | 问题                                               | 倾向                                                  |
| --- | -------------------------------------------------- | ----------------------------------------------------- |
| Q1  | 契约层自研还是用 oRPC / tRPC（§4.4）               | **已定：自研**                                        |
| Q2  | `core` 是一个包还是按领域拆多个包                  | 先一个包、内部按目录分模块；有独立发布需求再拆        |
| Q3  | 角色包放 `characters/` 还是 `packages/character-*` | `characters/`：不是 npm 包，不参与 Turborepo 构建任务 |
| Q4  | 是否需要视图内嵌模式（无透明窗口宿主下的看板娘）   | 等出现第二个宿主再做；本稿只保证能力声明              |

## 附录 A：耦合点文件清单（2026-10-28）

这是 P2 开始前的快照：P3 之后业务模块在 `packages/core/src`，`packages/electron` 已改名 `packages/host-electron`。

### A.1 实施后复测（2026-10-29，`release/2.0.5` + 本次收尾）

同一组命令换到新路径（在仓库根目录运行）：

```bash
for d in packages/core/src packages/host-electron/src; do
  (cd $d
   grep -rlE "app\.getPath\(" . | sort
   grep -rl "safeStorage" . | sort
   grep -rlE "import \{[^}]*\b(dialog|shell|clipboard|desktopCapturer|powerMonitor)\b[^}]*\} from 'electron'" . | sort
   grep -rlE "getAllWindows|webContents\.send" . | sort
   grep -rlE "from 'electron'|require\('electron'\)" . | sort)
done
grep -rlE "window\.(electronAPI|aiIPC)" packages/ai-chat/src packages/renderer/src | sort
```

| 统计                                                                  | 起草时（`packages/electron/src`） | `packages/core/src`                                                                                      | `packages/host-electron/src`                                                         |
| --------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `app.getPath`                                                         | 10                                | 0                                                                                                        | 2（`host/electronPorts.ts`、`host/processDefaults.ts`）                              |
| `safeStorage`                                                         | 9                                 | 8，全是命名 / 注释 / 持久化格式字面量（`encryption: 'safeStorage'`、`safeStorageFromSecrets`），没有调用 | 1（`host/electronPorts.ts`，`secrets` 端口实现）                                     |
| `dialog` / `shell` / `clipboard` / `desktopCapturer` / `powerMonitor` | 15                                | 0                                                                                                        | 3（`host/ClipboardGateway.ts`、`host/ScreenCapture.ts`、`security/windowGuards.ts`） |
| 窗口广播                                                              | 29                                | 1，只是 `cli/eventBatcher.ts` 的注释                                                                     | 4（`core/appIcon.ts`、`host/electronPorts.ts`、`host/liveWindows.ts`、`main.ts`）    |
| import electron 的文件                                                | —                                 | 0（lint error 守住）                                                                                     | 25                                                                                   |
| 视图里的 `window.electronAPI` / `window.aiIPC`                        | 21                                | —                                                                                                        | —（视图：0）                                                                         |

统计命令（在仓库根目录运行）：

```bash
cd packages/electron/src
grep -rlE "app\.getPath\(" . | sort
grep -rl "safeStorage" . | sort
grep -rlE "import \{[^}]*\b(dialog|shell|clipboard|desktopCapturer|powerMonitor)\b[^}]*\} from 'electron'" . | sort
grep -rlE "getAllWindows|webContents\.send" . | sort
cd - && grep -rlE "window\.electronAPI" packages/ai-chat/src packages/renderer/src | sort
```

**`app.getPath`（10）**：`character/CharacterPackService.ts`、`chat/assetProtocol.ts`、`core/Application.ts`、`desktop/DesktopService.ts`、`handlers/ipc/ConfigIpcHandler.ts`、`main.ts`、`services/ConfigService.ts`、`services/LoggerService.ts`、`services/UpdateService.ts`、`tts/TtsConfigStore.ts`

**`safeStorage`（9）**：`ai/AIRuntimeBoot.ts`、`cli/legacyCliKey.ts`、`core/Application.ts`、`extensions/ExtensionsService.ts`、`gateway/GatewayStore.ts`、`gateway/migrate.ts`、`gateway/types.ts`、`security/secretStorage.ts`、`voice/VoiceService.ts`

**`dialog` / `shell` / `clipboard` / `desktopCapturer` / `powerMonitor`（15）**：`ai/ClipboardGateway.ts`、`ai/ScreenCapture.ts`、`chat/ChatBackgroundService.ts`、`cli/accounts/AccountLogin.ts`、`cli/harness/Orchestrator.ts`、`core/Application.ts`、`diagnostics/DiagnosticsService.ts`、`extensions/ExtensionsService.ts`、`knowledge/KnowledgeService.ts`、`local/LocalHubService.ts`、`memory/MemoryService.ts`、`schedule/SchedulerService.ts`、`security/windowGuards.ts`、`usage/quality/QualityService.ts`、`utils/ErrorHandler.ts`

**窗口广播（29）**：`agents/AgentProgressService.ts`、`ai/mascotCommand.ts`、`chat/ChatBackgroundService.ts`、`cli/accounts/AccountLogin.ts`、`cli/accounts/AccountService.ts`、`cli/CliPluginHost.ts`、`cli/CliUpdateService.ts`、`cli/delegate/DelegateService.ts`、`cli/eventBatcher.ts`、`cli/harness/Orchestrator.ts`、`core/appIcon.ts`、`core/Application.ts`、`core/WindowManager.ts`、`desktop/DesktopService.ts`、`extensions/ExtensionsService.ts`、`i18n/index.ts`、`knowledge/KnowledgeService.ts`、`local/LocalModelService.ts`、`main.ts`、`mascot/MascotWindowController.ts`、`memory/MemoryService.ts`、`onboarding/OnboardingService.ts`、`schedule/SchedulerService.ts`、`services/UpdateService.ts`、`startup/StartupService.ts`、`theme/ThemeService.ts`、`usage/quality/QualityService.ts`、`usage/UsageService.ts`、`voice/VoiceService.ts`

其中 `core/WindowManager.ts`、`core/appIcon.ts`、`mascot/MascotWindowController.ts`、`main.ts` 属于宿主，P2 不改。

**`window.electronAPI` 使用者（21）**：
`ai-chat`：`components/SettingsView/UpdateSettings.tsx`、`services/diagnosticsClient.ts`、`services/fileAttachments.ts`；
`renderer`：`components/Mascot/{DesktopConfirm,InteractionSettings,MascotAudioBridge,MascotContextMenu,ReminderCard}.tsx`、`components/MessageBubble/MessageBubble.tsx`、`components/SpriteMascot/InteractionLite.tsx`、`components/ToolBar/index.tsx`、`hooks/useFileDropSummarize.ts`、`mascot/interaction/settings.ts`、`mascot/MascotDriver.tsx`、`mascot/openVoiceSettings.ts`、`mascot/scaleStore.ts`、`mascot/tts/{audioPlayback,replySpeech}.ts`、`mascot/voice/promptClips.ts`、`services/VoiceService.ts`、`utils/cache.ts`
