/**
 * D5 · 看板娘窗口 / 角色 / 灵动岛 / 聊天背景 / 文件 / 窗口（docs/design/core-host-decoupling.md §12 P1b）。
 *
 * 本文件只属于 D5：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：mascot、character、persona、island、chatBg、files、window、avatar（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `mascot:*`（mascot/MascotWindowController.ts、ai/mascotCommand.ts；electronAPI.mascotWindow / mascot / onMascotCommand）
 * - `character-pack:get-active`、`character:get-persona` / `character:persona-changed`（electronAPI.characterPack / persona）
 * - `island:*`、`chat-bg:*`（electronAPI.island / chatBg）、electronAPI.platform
 * - 旧窗口通道（handlers/ipc/WindowIpcHandler.ts、ConfigIpcHandler 的 save-model / get-saved-model）：
 *   quit-app、set-always-on-top、move-window、get/set-position、get-cursor-position、open-ai-chat、
 *   open-task-board、window-mouse-enter/leave
 *
 * 没有进契约的：electronAPI.files.pathFor（`webUtils.getPathForFile` 只能在 preload 里对真实 File 调用，
 * File 对象不能过线），由收尾批次在 preload 里另留具名能力。
 *
 * 约定见设计稿 §12「P1b 实施约定」：zod schema 从现有类型写、只用可序列化值；
 * 读用 query、写用 mutation、进度流用 stream；只给一个窗口用的过程写 `surfaces`，
 * 原来要用户确认的写 `dangerous: true`（本域没有）。
 */

import { z } from 'zod';

import type { EventMap, ProcedureMap, Surface } from '../contract';

import { AvatarCue, AvatarSemanticName } from './schemas';

// ---------------------------------------------------------------------------
// schema（照 @nomi-ai/types 与主进程服务的返回类型写；zod 4 的 number 已拒绝 NaN / Infinity）
// 会演进的顶层对象用 looseObject（未知字段透传）；字段固定的嵌套对象用 object（主进程的接口类型能直接赋值）
// ---------------------------------------------------------------------------

/** Linux 点击穿透的窗口形状矩形（窗口像素）—— types `ShapeRect` */
export const MascotShapeRect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/** 角色包围盒（窗口像素）；vw / vh = 测量时的视口尺寸 —— `mascot.setGeometry` */
export const MascotGeometry = z.object({
  left: z.number(),
  right: z.number(),
  top: z.number(),
  bottom: z.number(),
  vw: z.number().optional(),
  vh: z.number().optional(),
});

/** 互动设置 —— types `MascotInteractionConfig`（部分字段；主进程只取认识的布尔值） */
export const MascotInteractionConfig = z.looseObject({
  clickThrough: z.boolean().optional(),
  gravity: z.boolean().optional(),
  wander: z.boolean().optional(),
  reactions: z.boolean().optional(),
  globalLook: z.boolean().optional(),
  bubbleReplies: z.boolean().optional(),
});

/** 看板娘大小 —— types `MascotScaleState` */
export const MascotScaleState = z.looseObject({
  scale: z.number(),
  min: z.number(),
  max: z.number(),
  hardMax: z.number(),
  default: z.number(),
  step: z.number(),
  window: z.object({ width: z.number(), height: z.number() }),
});

/** 全局光标（相对窗口左上角，可能在窗口外）—— types `MascotCursorEvent` */
export const MascotCursorEvent = z.object({ x: z.number(), y: z.number(), inside: z.boolean() });

/** 窗口运动 —— types `MascotBodyEvent` */
export const MascotBodyEvent = z.looseObject({
  mode: z.enum(['idle', 'held', 'falling', 'walking']),
  vx: z.number(),
  vy: z.number(),
  ax: z.number(),
  ay: z.number(),
  dir: z.number(),
});

/** 桌面物理事件 —— types `MascotPhysicsEvent` */
export const MascotPhysicsEvent = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('grab') }),
  z.looseObject({ type: z.literal('release'), vx: z.number(), vy: z.number() }),
  z.looseObject({ type: z.literal('land'), speed: z.number() }),
  z.looseObject({ type: z.literal('bounce'), speed: z.number() }),
  z.looseObject({ type: z.literal('wall'), side: z.enum(['left', 'right']), speed: z.number() }),
  z.looseObject({ type: z.literal('arrive') }),
]);

/**
 * 主进程 → 看板娘指令（core `ai/mascotCommand.ts` 的 `MascotCommand`）：打开面板、说一句（可带语义手势）、
 * 朗读回复。角色的情绪 / 手势 / 活动不走这里，走语义事件 `avatar.event`（§10.5）。
 */
export const MascotCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open-panel'), panel: z.string() }),
  z.object({ type: z.literal('say'), text: z.string(), gesture: AvatarSemanticName.optional() }),
  z.looseObject({ type: z.literal('reply-speech') }),
]);

/** 只读快照（e2e / 调试）—— `mascot.debugSnapshot` */
export const MascotDebugSnapshot = z.looseObject({
  body: z.object({
    x: z.number(),
    y: z.number(),
    vx: z.number(),
    vy: z.number(),
    mode: z.string(),
  }),
  ignoring: z.boolean(),
  shapeRects: z.number(),
  clickThroughMode: z.enum(['ignore', 'shape']),
  box: z
    .object({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() })
    .nullable(),
  cfg: z.object({
    clickThrough: z.boolean(),
    gravity: z.boolean(),
    wander: z.boolean(),
    reactions: z.boolean(),
    globalLook: z.boolean(),
  }),
});

const HitboxRegion = z.object({
  top: z.number(),
  bottom: z.number(),
  left: z.number(),
  right: z.number(),
});

/** 当前角色包快照 —— electron `CharacterPackActiveSnapshot`（随角色包契约演进，未知字段透传） */
export const CharacterPackSnapshot = z.looseObject({
  source: z.enum(['userData', 'resources', 'builtin']),
  id: z.string().nullable(),
  mode: z.string().nullable(),
  /** 角色全名（第一次提到时用） */
  displayName: z.object({ zh: z.string(), en: z.string() }).nullable(),
  /** 角色简称（之后再提到时用）；旧主进程不发这个字段 */
  shortName: z.object({ zh: z.string(), en: z.string() }).nullable().optional(),
  /** 有运行时覆盖包时非空：character-pack://pack/... */
  assetBaseUrl: z.string().nullable(),
  onboarding: z
    .object({
      welcome: z.string(),
      profile: z.string(),
      provider: z.string(),
      privacy: z.string(),
    })
    .nullable(),
  voiceBaseUrl: z.string().nullable(),
  riveUrl: z.string().nullable(),
  staticUrl: z.string().nullable(),
  spriteManifestUrl: z.string().nullable(),
  hitboxes: z
    .object({
      regions: z.record(z.string(), HitboxRegion),
      bubbleAnchor: z.object({ x: z.number(), y: z.number() }).optional(),
    })
    .nullable(),
  rive: z.object({ artboard: z.string(), stateMachine: z.string() }).nullable(),
  /** 语义 → 资源（mapping.json，§10.5）；包没有 mapping.json 时为 null。旧主进程不发这个字段 */
  mapping: z
    .object({
      emotions: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
      activities: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
      gestures: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    })
    .nullable()
    .optional(),
  /** 角色文案（`locales/<lang>.json` 的 lines 与唤醒词 wakePhrase）；旧主进程只发 lines */
  locales: z
    .record(
      z.string(),
      z
        .object({
          lines: z.record(z.string(), z.string()).optional(),
          wakePhrase: z.string().optional(),
        })
        .optional(),
    )
    .nullable()
    .optional(),
  reason: z.string().optional(),
});

/** 角色人设 —— types `Persona` */
export const Persona = z.looseObject({
  characterId: z.string(),
  displayName: z.string(),
  /** 简称；旧主进程不发，用 displayName */
  shortName: z.string().optional(),
  systemPromptIdentity: z.string(),
  addressUser: z.string().optional(),
  greetings: z.array(z.string()),
});

const IslandKinds = z.object({
  message: z.boolean(),
  agent: z.boolean(),
  reminder: z.boolean(),
});

/** 灵动岛设置（写入后的值）—— electron `IslandSettings` */
export const IslandSettings = z.looseObject({
  enabled: z.boolean(),
  style: z.enum(['auto', 'pill']),
  kinds: IslandKinds,
});

/** 灵动岛设置 + 当前形态 —— electron `IslandService.get()` */
export const IslandState = IslandSettings.extend({
  mode: z.enum(['notch', 'pill']),
  platform: z.string(),
});

/** 灵动岛设置补丁 —— `Partial<IslandSettings>`（主进程 sanitizeIsland 再校验一遍） */
export const IslandPatch = z.looseObject({
  enabled: z.boolean().optional(),
  style: z.enum(['auto', 'pill']).optional(),
  kinds: IslandKinds.partial().optional(),
});

/** 聊天主面板背景 —— types `ChatBackgroundState` */
export const ChatBackgroundState = z.looseObject({
  imageUrl: z.string().nullable(),
  blur: z.number(),
  opacity: z.number(),
});

/** 背景补丁（主进程 sanitizeChatBg 再校验；空对象 = 只重新校验图片） */
export const ChatBackgroundPatch = z.looseObject({
  imageUrl: z.string().nullable().optional(),
  blur: z.number().optional(),
  opacity: z.number().optional(),
});

/** 旧 `open-ai-chat` / `open-task-board` 的返回（BaseIpcHandler 的成功 / 失败信封，视图按它提示） */
export const WindowOpenResult = z.looseObject({
  success: z.boolean(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// 过程
// ---------------------------------------------------------------------------

const MASCOT = ['mascot'] as const;
const CHAT = ['chat'] as const;
/** 看板娘大小：看板娘窗口自己（滚轮 / 菜单 / 快捷键）与对话窗口的设置页滑块 */
const MASCOT_OR_CHAT = ['mascot', 'chat'] as const;

export const mascotProcedures = {
  // —— 看板娘窗口互动（MascotWindowController；原 ipcRenderer.send，只接受看板娘窗口）
  'mascot.setShape': {
    kind: 'mutation',
    input: z.object({ rects: z.array(MascotShapeRect) }),
    output: z.void(),
    surfaces: MASCOT,
    description: 'mascot:shape — Linux 点击穿透的窗口形状；空数组 = 整个窗口',
  },
  'mascot.setHit': {
    kind: 'mutation',
    input: z.object({ hit: z.boolean() }),
    output: z.void(),
    surfaces: MASCOT,
    description: 'mascot:hit — 光标是否命中角色 / 界面（切换点击穿透）',
  },
  'mascot.setGeometry': {
    kind: 'mutation',
    input: MascotGeometry,
    output: z.void(),
    surfaces: MASCOT,
    description: 'mascot:geometry — 角色包围盒（物理地面 / 脚底锚点）',
  },
  'mascot.dragStart': {
    kind: 'mutation',
    input: z.object({ screenX: z.number().optional(), screenY: z.number().optional() }),
    output: z.void(),
    surfaces: MASCOT,
    description: 'mascot:drag-start — 省略坐标时主进程读取系统光标',
  },
  'mascot.dragMove': {
    kind: 'mutation',
    input: z.object({ screenX: z.number(), screenY: z.number() }),
    output: z.void(),
    surfaces: MASCOT,
    description: 'mascot:drag-move',
  },
  'mascot.dragEnd': {
    kind: 'mutation',
    input: z.void(),
    output: z.void(),
    surfaces: MASCOT,
    description: 'mascot:drag-end',
  },
  'mascot.setInteractionConfig': {
    kind: 'mutation',
    input: MascotInteractionConfig,
    output: z.void(),
    surfaces: MASCOT,
    description: 'mascot:interaction-config',
  },
  'mascot.wanderNow': {
    kind: 'mutation',
    input: z.void(),
    output: z.void(),
    surfaces: MASCOT,
    description: 'mascot:wander-now',
  },
  'mascot.debugSnapshot': {
    kind: 'query',
    input: z.void(),
    output: MascotDebugSnapshot,
    surfaces: MASCOT,
    description: 'mascot:debug-snapshot — 只读快照（e2e / 调试）',
  },

  // —— 看板娘大小（两个窗口都可调用）
  'mascot.scaleGet': {
    kind: 'query',
    input: z.void(),
    output: MascotScaleState,
    surfaces: MASCOT_OR_CHAT,
    description: 'mascot:scale-get',
  },
  'mascot.scaleSet': {
    kind: 'mutation',
    input: z.object({ scale: z.number() }),
    output: MascotScaleState,
    surfaces: MASCOT_OR_CHAT,
    description: 'mascot:scale-set',
  },
  'mascot.scaleStep': {
    kind: 'mutation',
    input: z.object({ dir: z.union([z.literal(1), z.literal(-1)]) }),
    output: MascotScaleState,
    surfaces: MASCOT_OR_CHAT,
    description: 'mascot:scale-step（±1）',
  },
  'mascot.scaleWheel': {
    kind: 'mutation',
    input: z.object({ deltaY: z.number(), deltaMode: z.number().optional() }),
    output: MascotScaleState,
    surfaces: MASCOT_OR_CHAT,
    description: 'mascot:scale-wheel — Ctrl/⌘+滚轮累计的 deltaY（向上滚 = 放大）',
  },
  'mascot.scaleReset': {
    kind: 'mutation',
    input: z.void(),
    output: MascotScaleState,
    surfaces: MASCOT_OR_CHAT,
    description: 'mascot:scale-reset',
  },

  // —— 旧的角色模型名（ConfigIpcHandler：save-model / get-saved-model；只在看板娘 preload）
  'mascot.saveModel': {
    kind: 'mutation',
    input: z.object({ modelName: z.string() }),
    output: z.void(),
    surfaces: MASCOT,
    description: 'save-model',
  },
  'mascot.getSavedModel': {
    kind: 'query',
    input: z.void(),
    output: z.string(),
    surfaces: MASCOT,
    description: 'get-saved-model',
  },

  // —— 角色包 / 人设（两个窗口都有）
  'character.getActivePack': {
    kind: 'query',
    input: z.void(),
    output: CharacterPackSnapshot,
    description: 'character-pack:get-active — 当前角色包快照（运行时覆盖包 / 内置包）',
  },
  'persona.get': {
    kind: 'query',
    input: z.void(),
    output: Persona,
    description: 'character:get-persona',
  },

  // —— 灵动岛（只在对话窗口 preload）
  'island.get': {
    kind: 'query',
    input: z.void(),
    output: IslandState,
    surfaces: CHAT,
    description: 'island:get',
  },
  'island.set': {
    kind: 'mutation',
    input: IslandPatch,
    output: IslandSettings,
    surfaces: CHAT,
    description: 'island:set',
  },
  'island.test': {
    kind: 'mutation',
    input: z.void(),
    output: z.boolean(),
    surfaces: CHAT,
    description: 'island:test — 弹一条示例通知；返回是否显示',
  },

  // —— 聊天主面板背景（只在对话窗口 preload）
  'chatBg.get': {
    kind: 'query',
    input: z.void(),
    output: ChatBackgroundState,
    surfaces: CHAT,
    description: 'chat-bg:get',
  },
  'chatBg.set': {
    kind: 'mutation',
    input: ChatBackgroundPatch,
    output: ChatBackgroundState,
    surfaces: CHAT,
    description: 'chat-bg:set — 合并补丁并重新校验图片（空补丁 = 只重新校验）',
  },
  'chatBg.reset': {
    kind: 'mutation',
    input: z.void(),
    output: ChatBackgroundState,
    surfaces: CHAT,
    description: 'chat-bg:reset',
  },
  'chatBg.pickImage': {
    kind: 'mutation',
    input: z.void(),
    output: ChatBackgroundState,
    surfaces: CHAT,
    description: 'chat-bg:pick-image — 选图并导入；取消时返回当前状态',
  },

  // —— 旧窗口通道（WindowIpcHandler；只在看板娘 preload）
  'window.quit': {
    kind: 'mutation',
    input: z.void(),
    output: z.void(),
    surfaces: MASCOT,
    description: 'quit-app',
  },
  'window.setAlwaysOnTop': {
    kind: 'mutation',
    input: z.object({ flag: z.boolean() }),
    output: z.void(),
    surfaces: MASCOT,
    description: 'set-always-on-top（看板娘窗口）',
  },
  'window.move': {
    kind: 'mutation',
    input: z.object({ deltaX: z.number(), deltaY: z.number() }),
    output: z.void(),
    surfaces: MASCOT,
    description: 'move-window — 看板娘窗口按增量移动',
  },
  'window.getPosition': {
    kind: 'query',
    input: z.void(),
    output: z.tuple([z.number(), z.number()]),
    surfaces: MASCOT,
    description: 'get-position — 看板娘窗口左上角',
  },
  'window.setPosition': {
    kind: 'mutation',
    input: z.object({ x: z.number(), y: z.number() }),
    output: z.void(),
    surfaces: MASCOT,
    description: 'set-position',
  },
  'window.getCursorPosition': {
    kind: 'query',
    input: z.void(),
    output: z.object({ x: z.number(), y: z.number() }),
    surfaces: MASCOT,
    description: 'get-cursor-position — 系统光标的屏幕坐标',
  },
  'window.openAiChat': {
    kind: 'mutation',
    input: z.void(),
    output: WindowOpenResult,
    surfaces: MASCOT,
    description: 'open-ai-chat',
  },
  'window.openTaskBoard': {
    kind: 'mutation',
    input: z.void(),
    output: WindowOpenResult,
    surfaces: MASCOT,
    description: 'open-task-board — 打开对话窗口的日程页',
  },
  'window.platform': {
    kind: 'query',
    input: z.void(),
    output: z.string(),
    description: 'electronAPI.platform / mascotWindow.platform（宿主的 process.platform）',
  },
} as const satisfies ProcedureMap;

export const mascotEvents = {
  /** mascot:scale-changed（看板娘窗口与对话窗口） */
  'mascot.scaleChanged': MascotScaleState,
  /** mascot:cursor（~30Hz，只在光标移动时） */
  'mascot.cursor': MascotCursorEvent,
  /** mascot:body（运动中每帧，静止时 ~2Hz） */
  'mascot.body': MascotBodyEvent,
  /** mascot:physics-event */
  'mascot.physicsEvent': MascotPhysicsEvent,
  /** mascot:command（托盘 / 服务 → 看板娘：打开面板、说一句、朗读） */
  'mascot.command': MascotCommand,
  /** avatar:event（AI 工具 / 托盘 / 内核服务 → 角色：语义情绪、手势、活动，§10.5） */
  'avatar.event': AvatarCue,
  /** character:persona-changed */
  'persona.changed': Persona,
  /** chat-bg:changed */
  'chatBg.changed': ChatBackgroundState,
  /** window-mouse-enter（看板娘窗口） */
  'window.mouseEnter': z.null(),
  /** window-mouse-leave（看板娘窗口） */
  'window.mouseLeave': z.null(),
} as const satisfies EventMap;

/** 事件的订阅白名单（§8）：光标 / 物理 / 鼠标进出只给看板娘窗口 */
export const mascotEventSurfaces = {
  'mascot.cursor': ['mascot'],
  'mascot.body': ['mascot'],
  'mascot.physicsEvent': ['mascot'],
  'avatar.event': ['mascot'],
  'window.mouseEnter': ['mascot'],
  'window.mouseLeave': ['mascot'],
} as const satisfies Partial<Record<keyof typeof mascotEvents, readonly Surface[]>>;

/** 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出 */
export const mascotErrors = [
  /** 背景图超过大小上限（types `CHAT_BG_ERROR.tooLarge`；消息仍以该码开头） */
  'CHAT_BG_TOO_LARGE',
  /** 背景图格式不支持（types `CHAT_BG_ERROR.unsupported`） */
  'CHAT_BG_UNSUPPORTED',
] as const satisfies readonly string[];

export type MascotProcedureName = keyof typeof mascotProcedures & string;
export type MascotEventName = keyof typeof mascotEvents & string;
