# 内核、宿主、视图、角色四分离（设计稿）

> 状态：**实施中**。起草 2026-10-28。
> 已定（2026-10-28）：角色文案跟着角色包走（§10.2）；契约层自研（§4.4）；项目没有 Live2D，`live2d` 命名与死代码直接删除，不保留别名（§10.5）。
> 查证：基于 `release/2.0.5` 分支代码统计（§2）；数字是起草当天的快照，实施前重新跑附录 A 的命令。
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

| 包                        | 可以依赖                                                                                                             | 不得依赖                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `contract`                | `zod`、`types`                                                                                                       | 任何运行时包                                                       |
| `host-ports`              | `types`                                                                                                              | 任何运行时包                                                       |
| `core`                    | `contract`、`host-ports`、`gateway`、`cli-sdk`、`ai-runtime`（去掉 Electron 适配器后）、`character-contract`、`i18n` | `electron`、任何视图包、`ui`                                       |
| `host-electron`           | 以上全部 + `electron`                                                                                                | 视图包的源码（只加载它们的构建产物）                               |
| 视图（ai-chat、renderer） | `contract` 的 client、`ui`、`i18n`、`avatar-runtime`                                                                 | `core`、`host-*`、`electron`、`window.*IPC` / `window.electronAPI` |
| `avatar-runtime`          | `character-contract`、浏览器 API                                                                                     | `electron`、`contract`（通过注入的事件源接 AI，§10.5）             |
| `characters/*`            | 无（不含代码）                                                                                                       | —                                                                  |

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

| 约束         | 规则                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| 可序列化     | 参数、返回值、事件只用 JSON 可表达的值；二进制用 `Uint8Array`；不传函数、class 实例 |
| 流式         | `stream` = 请求 id + 若干 chunk 事件 + 结束 / 错误；取消用显式 `abort(id)`          |
| 不用同步调用 | 现有 `kind: 'sync-return'` 一律改为异步（它在 Electron 里也只是 `invoke`）          |
| 错误         | 统一 `{ code, message, data? }`，`code` 在契约里枚举；不透传 Error 对象             |
| 大文件       | 不经契约传内容；传路径或宿主签发的 `asset://` URL                                   |

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
interface WindowsPort {
  open(surface: 'chat' | 'mascot' | 'settings', intent?: { route?: string }): void;
  focus(surface: Surface): void;
  isVisible(surface: Surface): boolean;
}
```

窗口的尺寸、位置、透明、置顶、物理效果都是宿主自己的事。

### 6.3 端口实现的位置

| 实现            | 内容                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `host-electron` | Electron 实现；`ai-runtime` 的 `createElectronIpcAdapter`、`createElectronLifecycle` 也搬到这里  |
| `host-node`     | `paths` 指向临时目录；`secrets` 用内存或明文（仅测试）；`dialogs` 返回预设值；`windows` 记录调用 |

`safeStorage` 只是 `secrets` 端口的一种实现。现有 `security/secretStorage.ts` 的逻辑（可用性检查、迁移）留在内核，只把 `safeStorage.encryptString` 调用换成端口。

## 7. 内核：`@nomi-ai/core`

### 7.1 组合根

```ts
// packages/core/src/index.ts
export function createCore(deps: { ports: HostPorts; logger: LoggerFactory; config: CoreConfig }): Core;

interface Core {
  router: Router; // implement(contract, …) 的结果
  start(): Promise<void>;
  stop(): Promise<void>;
}

// packages/host-electron/src/main.ts
const ports = createElectronPorts();
const core = createCore({ ports, logger, config });
const stopServe = createElectronIpcTransport(guard).serve(core.router);
await core.start();
```

- 内核没有模块级单例。现有 `core/ServiceContainer.ts`、`core/EventBus.ts` 搬进内核，作为 `createCore` 内部实现。
- `LoggerService` / `createMainLogger` 改为注入的 `LoggerFactory`；日志文件路径来自 `ports.paths.logs()`。
- 主进程 i18n（`electron/src/i18n`）与平台无关，搬入内核；界面语言变化通过 `settings.changed` 事件通知。

#### 实施约定（P2 起，P3 搬家前）

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

- **传输层负责填 caller**：Electron 根据 webContents id 与加载的 URL 判断；WebSocket 用启动时下发的一次性 token，并且只监听 `127.0.0.1`。
- **router 中间件负责判定**：契约里每个过程可以声明 `surfaces: ['chat']`；`dangerous: true` 的过程只接受 `trusted` 调用者，必要时要求视图内确认。
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

`electron/src/brand.ts` 只留产品常量；`APP_DISPLAY_NAME_ZH = 'Nomi·诺米'` 里的「诺米」属于角色，改为从角色包读取。全仓库的 `Nomi` / `诺米` 逐一归类：产品用法改用 `brand.appName`，角色用法改从人设读取（§11.2 的检查依赖这一步）。

### 10.2 角色包只含数据

```
characters/nomi/
  manifest.json        id、contractVersion、assets.mode、capabilities、layout（窗口尺寸、命中区、气泡锚点）
  persona.json         displayName、systemPromptIdentity、addressUser、greetings、tips
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
  addressUser?: string;
  greetings: string[];
}
```

- `WaifuAgentPresetPlugin` 与 ai-chat 的默认系统提示都从这里读。
- 删除两处硬编码：`WaifuAgentPresetPlugin.ts` 的「你是 Nomi（诺米）……」兜底，以及 `IPCClient.ts` 使用的 `you-are-nomi-an-ai-companion-who-lives` key（文本搬进 `characters/nomi/persona.json`，同时删 `en.json` 对应条目）。
- 两份 `character.generated.json` 删除，由 `PersonaService` 和 `avatar-runtime` 从同一个解析结果读取。

**这一步改动最小，并且直接修复「换了皮，人设还是 Nomi」的问题，排在最前（§12 P0）。**

### 10.5 AI 与角色之间只传语义事件

AI 不再知道动作名和 clip 名：

| 方向      | 事件                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| AI → 角色 | `emotion(name, weight)`、`speaking(start / stop, envelope)`、`activity(thinking / toolRunning / idle)`、`gesture(name)` |
| 角色 → AI | `touched(hitbox)`、`clicked`、`scene(…)`（现有 `WaifuMascotSceneReporter` 的内容）                                      |

- 角色包的 `mapping.json` 把语义翻译成自己的资源，例如 `happy → smile_02`、`toolRunning → typing_loop`；没有映射就忽略。
- 项目没有 Live2D 运行时，`live2d` 只是历史命名，挂在驱动 Rive / sprite 的在用链路上。处理：没有调用方的部分（例如 `setParameter`、`LIVE2D_NOT_AVAILABLE`）直接删；在用的部分改名为 avatar，**不保留旧名别名**。
- 工具改名：`live2d_play_motion` → `avatar_gesture`，`live2d_set_expression` → `avatar_emotion`；preset 名 `waifu` → `companion`。
- `ai-sdk` 的 `Live2dFacade` → `AvatarFacade`，`Live2dSeamPlugin` / `seams/live2d.ts` → avatar，事件 `live2d:touch` → `avatar:touch`。
- 保留 `ConfigIpcHandler` 中清理旧 `displayMode: 'live2d'` 配置的迁移逻辑（它处理的是用户磁盘上的旧数据）。

### 10.6 `@nomi-ai/avatar-runtime`

从 `renderer/src/mascot` 拆出，纯浏览器包：

- **内容**：`MascotBackend` 接口与 `backends/`（rive / sprite / static）、`expressionDirector`、`mood`、`motion`、`rig`、`layeredRig`、`interaction`（命中区）、口型消费、`characterVoice`。
- **输入**：`manifest + mapping + resolveAsset(path) → url` + 一个 `AvatarEventSource`（语义事件流）。
- **输出**：交互事件（`touched`、`clicked`）。
- **不依赖** `contract`、`electron`、`ai-sdk-client`。`AvatarEventSource` 由 renderer 用契约 client 实现并注入，所以 avatar-runtime 可以单独在 Storybook 或网页里运行。

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

工具：ESLint `no-restricted-imports` + `no-restricted-globals` 覆盖大部分；包级依赖方向用 dependency-cruiser（MIT）或在 `scripts/` 写检查脚本。

### 11.2 名字扫描

`scripts/check-character-leak`：`characters/nomi` 与 `brand` 之外不得出现角色名（`诺米`、角色语境下的 `Nomi`）。产品名统一用 `brand.appName`。允许清单写在脚本里，加条目要说明理由。

### 11.3 替身验收（最关键）

| 验收                 | 做法                                                                                                                                                     | 证明   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 无界面宿主跑通 e2e   | `host-node` + in-process 传输，在 Vitest 里启动整个内核，跑现有 `e2e/` 用例；不需要 Electron 和 xvfb                                                     | G1、G4 |
| 视图在普通浏览器运行 | 开发态内核开 WebSocket 传输，ai-chat 在 Chrome 直接打开 6128 也能对话                                                                                    | G2     |
| 替身角色             | `characters/test-dummy`：static 模式、一张占位图、名字与人设完全不同；用它跑 e2e，断言界面文本与发出的系统提示中都不含 `Nomi` / `诺米`（产品名区域除外） | G5     |
| 契约兼容             | 契约 major 不变时，旧视图构建对新内核跑一遍冒烟                                                                                                          | G3     |

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
> 搬目录（P3）尚未开始。
>
> C1 已完成（分支 `refactor/c1-characters`）：官方角色是普通角色包 `characters/nomi`，构建期由
> `CHARACTER_PACK`（缺省为它）选包，Vite 插件直接读包、不改源树；Scheme A 原地覆盖与两份
> `character.generated.json` 已删除；运行时覆盖包与内置包都经 `validatePack`（覆盖包 `lenient`，
> 非结构性问题只警告）。官方包与 2.0.5 行为对齐：不声明 `layout.hitboxes` / `bubbleAnchor`（触摸仍走几何
> 推断），`manifest.catalog` 让生成的 `model-list.json` 与 2.0.5 一致（仅素材路径改到 `./character/`）。
> 后续：
>
> - 用 `characters/test-dummy` 跑 e2e 验收（§11.3 替身角色，G5 尚未达成）；
> - `scripts/check-character-leak`（§11.2）尚未实现；
> - 界面文案里点名 Nomi 的字符串还没按「产品名 / 角色名」分拣（§10.1）；
> - `examples/static-demo.pack` 仍是旧布局（`layout/hitboxes.json`、`copy/`），靠迁移读取；
> - `character-pack:get-active` 的返回多了 `locales`，内置包也会填 `id` / `mode` / `displayName` /
>   `locales` 等身份字段；P1b 把这些同步进 `contract` 的通道定义。

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
> - 契约事件不按 surface 分发（只推给订阅了的窗口），`events.publish` 的 `surface` 目前只是发布方意图；
> - ai-chat 的部分视图测试仍用旧形状的假 `window.aiIPC`，经 `tests/helpers/{codingApi,shellApi}.ts` 把契约调用转回旧通道名，
>   以后改成契约层的假实现；
> - e2e-headed 只在 macOS 上跑过部分用例（E5、E17 等），完整一轮要在 Linux + xvfb 上跑；看板娘拖拽 / 点击上报从单向消息
>   变成契约往返，拖拽上报已串行化并按帧合并 move（renderer `mascot/interaction/dragReporter.ts`，上一条回应前不发下一条），
>   发布前仍要在 Windows 真机上确认拖拽手感；
> - 两个 preload 内容已相同，可以合成一个包；`security/ipcSenderGuard.ts` 仍在 electron import 白名单里（P3 随宿主搬家）；
> - `voice-settings:changed`（→ `voice.mascotSettingsChanged`）主进程没有发布方；MCP 信任级别（`ext.mcpUpsert` 等）
>   是否算 `dangerous` 待定。

| 阶段 | 内容                                                                                                                                                                | 完成标准                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| P0   | ① lint 护栏：`packages/electron/src` 中除宿主目录（§7.2 右列）外，新增 electron import 报错（已有的列入白名单，只减不增）；② `PersonaService`，删两处人设硬编码     | 护栏进 CI；换皮后系统提示不再是 Nomi                   |
| P1a  | **已完成**。建 `contract` 与 `defineContract`；AI 门面（35 个 `ai.*` 过程 + 12 个事件）上契约，取代两份 `channels.ts`；`ClientAIClient` 改走 `window.nomiTransport` | AI 门面只经契约访问；两份 `channels.ts` 删除           |
| P1b  | **已完成**。其余 `ai:*` 服务通道与 `window.electronAPI` 的能力逐个进契约；视图改用 client；删除 `window.aiIPC` / `window.electronAPI`                               | 视图中不再出现 `window.aiIPC` / `window.electronAPI`   |
| P2   | 建 `host-ports`；替换 `app.getPath`（10）、`safeStorage`（9）、`dialog/shell/clipboard` 等（15）；29 处窗口广播改为 `ctx.events.publish`                            | `packages/electron/src` 中业务模块不再 import electron |
| P3   | 物理搬家：业务模块 → `packages/core`；`packages/electron` → `packages/host-electron`；ai-runtime 的 Electron 适配器移入宿主                                         | 目录与 §3.3 一致；P0 白名单清空                        |
| P4   | `host-node` + in-process / WebSocket 传输；`e2e/` 改跑无界面宿主                                                                                                    | §11.3 前两项通过                                       |
| C1   | `character-contract` 包；官方资产与人设集中到 `characters/nomi`；删 Scheme A 原地覆盖与两份 `character.generated.json`                                              | 官方构建与白标构建走同一路径                           |
| C2   | 拆出 `avatar-runtime`；renderer 只留窗口壳                                                                                                                          | avatar-runtime 能在 Storybook 单独运行                 |
| C3   | 语义事件协议 + `mapping.json`；工具与 preset 改名（不保留别名）                                                                                                     | AI 侧代码中不出现 clip / motion 名；§11.3 替身角色通过 |

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
   宿主 `electron/tests/unit/host/contract/<f>.test.ts`（`createContractServices()` + 假服务 →
   `createAppRouter` 或 `createTestClient`，断言委派、FORBIDDEN、事件桥）；视图把 `window.aiIPC` 的 mock 换成
   `vi.mock('…/services/api')`，返回 `@nomi-ai/contract/testing` 的 `createTestClient(appContract, {…}).api`。
10. **构建**：视图与主进程读契约的 dist。改完契约后重建，并且与依赖它的类型检查一起放在锁里，避免并行时 tsup 清空
    dist：`node scripts/with-lock.mjs contract pnpm --filter @nomi-ai/contract build`、
    `node scripts/with-lock.mjs contract pnpm --filter @nomi-ai/electron typecheck`。

收尾批次（不属于任何域，已完成，见上文进度）：删 preload 里的 `aiIPC` / `electronAPI` 与 `packages/types` 的 `IpcApi`、各服务的
`registerIpc` 与旧处理器（及 `ProviderIpcServer` / `CapabilityIpcServer` / `AiChatCompat`）、事件桥里旧通道的广播；
e2e-headed 改走契约；lint 禁止视图访问 `window.aiIPC` / `window.electronAPI`（§11.1）。

## 13. 风险、取舍与待决

### 13.1 风险

| 风险                                 | 应对                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| P2 广播替换面广，容易漏掉事件        | 先在 `EventBroadcaster` 侧加「未声明事件」告警；契约事件表与实际 publish 做对照测试 |
| 契约序列化约束导致现有接口要改形状   | 先列出所有传函数 / 实例 / 同步调用的接口，P1 开工前评估                             |
| 搬家（P3）冲掉进行中的分支           | 选在发版后的窗口一次性搬；用 `git mv` 保留历史；提前通知                            |
| 开发态 userData 路径变化             | `paths` 端口的 Electron 实现沿用 `utils/legacyUserData.ts` 的迁移逻辑               |
| 工具改名影响已保存的会话与外部提示词 | 已定不保留别名：历史会话里的旧工具调用只作展示，不重放；changeset 写明改名          |
| WebSocket 传输带来新的本机攻击面     | 只在开发态和 sidecar 宿主启用；只监听 `127.0.0.1`；一次性 token；仍经 §8 中间件     |

### 13.2 待决

| #   | 问题                                               | 倾向                                                  |
| --- | -------------------------------------------------- | ----------------------------------------------------- |
| Q1  | 契约层自研还是用 oRPC / tRPC（§4.4）               | **已定：自研**                                        |
| Q2  | `core` 是一个包还是按领域拆多个包                  | 先一个包、内部按目录分模块；有独立发布需求再拆        |
| Q3  | 角色包放 `characters/` 还是 `packages/character-*` | `characters/`：不是 npm 包，不参与 Turborepo 构建任务 |
| Q4  | 是否需要视图内嵌模式（无透明窗口宿主下的看板娘）   | 等出现第二个宿主再做；本稿只保证能力声明              |

## 附录 A：耦合点文件清单（2026-10-28）

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
