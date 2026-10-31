/**
 * 角色包数据文件的 zod schema 与类型：manifest / persona / mapping / locales。
 * 角色包只含数据，不含代码（docs/design/core-host-decoupling.md §10.2）。
 */
import { z } from 'zod';

import { HITBOX_IDS, PACK_MODES, REMOTE_ASSET_KINDS } from './contract';
import { normalizePackPath } from './paths';

const nonEmpty = z.string().trim().min(1);

/** 包内相对路径：不得是绝对路径或越出包目录。 */
export const packPathSchema = z.string().refine((p) => normalizePackPath(p) !== null, {
  message: 'must be a relative path inside the pack',
});

const ratio = z.number().min(0).max(1);

export const hitboxRegionSchema = z
  .object({ top: ratio, bottom: ratio, left: ratio, right: ratio })
  .refine((r) => r.top < r.bottom && r.left < r.right, {
    message: 'top must be < bottom and left must be < right',
  });
export type HitboxRegion = z.infer<typeof hitboxRegionSchema>;

export const hitboxIdSchema = z.enum(HITBOX_IDS);

export const bubbleAnchorSchema = z.object({ x: ratio, y: ratio });
export type BubbleAnchor = z.infer<typeof bubbleAnchorSchema>;

export const windowSizeSchema = z.object({
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
});
export type WindowSize = z.infer<typeof windowSizeSchema>;

/** 布局：窗口尺寸、命中区（角色框的比例）、气泡锚点。 */
export const layoutSchema = z.object({
  window: windowSizeSchema.optional(),
  hitboxes: z.partialRecord(hitboxIdSchema, hitboxRegionSchema).optional(),
  bubbleAnchor: bubbleAnchorSchema.optional(),
});
export type PackLayout = z.infer<typeof layoutSchema>;

export const packModeSchema = z.enum(PACK_MODES);

export const assetsSchema = z.looseObject({
  mode: packModeSchema.default('rive'),
  rive: packPathSchema.optional(),
  sprite: packPathSchema.optional(),
  static: packPathSchema.optional(),
  voice: packPathSchema.optional(),
  onboarding: packPathSchema.optional(),
  /** 旧版 layout/ 目录（含 hitboxes.json） */
  layout: packPathSchema.optional(),
  /** 旧版 copy/ 目录 */
  copy: packPathSchema.optional(),
  /** 声明为远程的素材（按需下载，本地可以没有） */
  remote: z.array(z.enum(REMOTE_ASSET_KINDS)).optional(),
});
export type PackAssets = z.infer<typeof assetsSchema>;

/** 包声明自己支持的资源；运行时按它降级，未知动作跳过。 */
export const capabilitiesSchema = z.looseObject({
  riveMotions: z.array(nonEmpty).optional(),
  spriteActions: z.array(nonEmpty).optional(),
  /** 包的表情名（mapping.json 的 emotions 指向它们） */
  expressions: z.array(nonEmpty).optional(),
  voiceClipIds: z.array(nonEmpty).optional(),
  /** 是否带口型 / 眨眼等可选能力 */
  lipSync: z.boolean().optional(),
  blink: z.boolean().optional(),
});
export type PackCapabilities = z.infer<typeof capabilitiesSchema>;

export const localizedNameSchema = z.union([
  nonEmpty,
  z.object({ zh: nonEmpty.optional(), en: nonEmpty.optional() }),
]);

export const packIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,63}$/,
    'id must be lowercase letters, digits, - or _ (max 64 chars)',
  );

/**
 * 模型列表条目（renderer `assets/models/model-list.json`）的展示信息。缺省时由
 * persona 名字与 mode 推导。
 */
export const catalogSchema = z.object({
  displayName: nonEmpty.optional(),
  description: nonEmpty.optional(),
  /** 覆盖 credits.author，仅用于列表展示 */
  author: nonEmpty.optional(),
  tags: z.array(nonEmpty).optional(),
  /** 列表文件的版本号 */
  version: nonEmpty.optional(),
  /** ISO 时间 */
  lastUpdated: nonEmpty.optional(),
});
export type PackCatalog = z.infer<typeof catalogSchema>;

export const manifestSchema = z.looseObject({
  schema: z.literal(1),
  id: packIdSchema,
  contractVersion: z.number().int().positive(),
  version: z.string().optional(),
  /** 旧字段，人设以 persona.json 为准 */
  displayName: localizedNameSchema.optional(),
  engines: z.record(z.string(), z.string()).optional(),
  assets: assetsSchema,
  rive: z.object({ artboard: nonEmpty.optional(), stateMachine: nonEmpty.optional() }).optional(),
  defaults: z.record(z.string(), z.unknown()).optional(),
  capabilities: capabilitiesSchema.optional(),
  layout: layoutSchema.optional(),
  catalog: catalogSchema.optional(),
});
export type PackManifest = z.infer<typeof manifestSchema>;
/** 未经默认值填充的 manifest 输入形状。 */
export type PackManifestInput = z.input<typeof manifestSchema>;

/** persona.json：角色身份。对话的系统提示与问候都从这里读（§10.4）。 */
export const personaSchema = z.object({
  /** 全名：界面里第一次提到角色时用（docs/BRAND.md） */
  displayName: nonEmpty,
  /** 简称：之后再提到时用；缺省时同 displayName（见 `personaNames`） */
  shortName: nonEmpty.optional(),
  systemPromptIdentity: nonEmpty,
  /**
   * 界面里指代角色的人称代词（「点她的『AI 对话』」）；按语言给，英文用主格（she / he / it / they）。
   * 缺省为中性的「它」/ it（见 `personaPronoun`），不沿用主语言的值。
   */
  pronoun: nonEmpty.optional(),
  /** 角色对用户的称呼 */
  addressUser: nonEmpty.optional(),
  /** 问候语；可以为空数组，validatePack 会给警告 */
  greetings: z.array(nonEmpty),
  tips: z.array(nonEmpty).optional(),
});
export type PersonaData = z.infer<typeof personaSchema>;

const resourceRef = z.union([nonEmpty, z.array(nonEmpty).min(1)]);
const semanticMap = z.record(nonEmpty, resourceRef);

/**
 * mapping.json：语义 → 引擎资源 id（一个或多个，多个时运行时任选）。
 * `emotions` 指向表情，`activities` / `gestures` 指向动作。
 * 键可以是契约词表外的名字（向前兼容），validatePack 只给警告；运行时忽略没有映射的名字。
 */
export const mappingSchema = z.object({
  emotions: semanticMap.optional(),
  activities: semanticMap.optional(),
  gestures: semanticMap.optional(),
});
export type PackMapping = z.infer<typeof mappingSchema>;

/** locales/{zh,en}.json：角色文案（台词、提示语、语音字幕），不进全局 en.json。 */
export const characterLocaleSchema = z.object({
  /** 覆盖 persona.json 中对应语言的字段 */
  persona: personaSchema.partial().optional(),
  wakePhrase: nonEmpty.optional(),
  /** 台词 / 字幕，键为稳定 clip id 或台词 key */
  lines: z.record(nonEmpty, z.string()).optional(),
});
export type CharacterLocaleData = z.infer<typeof characterLocaleSchema>;
