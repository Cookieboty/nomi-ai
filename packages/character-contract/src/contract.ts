/**
 * 机器可读契约（`contract.json`）与稳定语音 id 表（`voice-ids.json`）的类型化入口。
 * 两份 JSON 放在包根目录，是唯一来源；脚本可直接读 `@nomi-ai/character-contract/contract.json`。
 */
import contractJson from '../contract.json';
import voiceIdsJson from '../voice-ids.json';

/** 契约主版本。manifest 的 `contractVersion` 大于它时，本版应用不能加载该包。 */
export const CHARACTER_CONTRACT_VERSION = 1 as const;

export const PACK_MODES = ['rive', 'sprite', 'static'] as const;
export type PackMode = (typeof PACK_MODES)[number];

export const HITBOX_IDS = ['head', 'face', 'body', 'hand', 'hem'] as const;
export type HitboxId = (typeof HITBOX_IDS)[number];

/** 旧命中区名 → 现名（v1 起 `skirt` 改为 `hem`）。 */
export const LEGACY_HITBOX_ALIAS: Readonly<Record<string, HitboxId>> = { skirt: 'hem' };

export const ONBOARDING_FILES = [
  'welcome.webp',
  'profile.webp',
  'provider.webp',
  'privacy.webp',
] as const;

/**
 * 语义事件词表（docs/design/core-host-decoupling.md §10.5）。AI 侧（工具、内核服务）只说这些名字，
 * 角色包的 mapping.json 把它们翻译成自己的资源；没有映射的名字运行时忽略。
 */

/** 语义情绪（AI → 角色，`emotion(name, weight)`）：映射到包的表情。 */
export const SEMANTIC_EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'relaxed',
  'shy',
  'confused',
  'sleepy',
] as const;
export type SemanticEmotion = (typeof SEMANTIC_EMOTIONS)[number];

/**
 * 语义活动状态（AI → 角色，`activity(name)`）：映射到保持姿态的动作。`idle` 结束当前活动，
 * 不需要映射。
 */
export const SEMANTIC_ACTIVITIES = ['idle', 'thinking', 'toolRunning'] as const;
export type SemanticActivity = (typeof SEMANTIC_ACTIVITIES)[number];

/** 语义手势（AI → 角色，`gesture(name)`）：映射到包的动作。`random` 由引擎随机挑一个手势。 */
export const SEMANTIC_GESTURES = [
  'wave',
  'greet',
  'nod',
  'shakeHead',
  'bow',
  'salute',
  'pray',
  'okHand',
  'think',
  'explain',
  'eureka',
  'puzzled',
  'listen',
  'lookAround',
  'lookLeftRight',
  'peek',
  'heart',
  'blowKiss',
  'shy',
  'coverFace',
  'apologize',
  'surprise',
  'startle',
  'sigh',
  'smug',
  'aggrieved',
  'tears',
  'angry',
  'coldSweat',
  'daze',
  'cheer',
  'thumbsUp',
  'peace',
  'celebrate',
  'clap',
  'hop',
  'wink',
  'tongue',
  'cute',
  'reachOut',
  'work',
  'yawn',
  'stretch',
  'goodnight',
  'hum',
  'random',
] as const;
export type SemanticGesture = (typeof SEMANTIC_GESTURES)[number];

/** 引擎保留的映射目标：不是包里的资源，由引擎解释（`random` = 随机手势）。 */
export const MAPPING_RESERVED_TARGETS = ['random'] as const;

export function isSemanticEmotion(name: unknown): name is SemanticEmotion {
  return (SEMANTIC_EMOTIONS as readonly unknown[]).includes(name);
}
export function isSemanticActivity(name: unknown): name is SemanticActivity {
  return (SEMANTIC_ACTIVITIES as readonly unknown[]).includes(name);
}
export function isSemanticGesture(name: unknown): name is SemanticGesture {
  return (SEMANTIC_GESTURES as readonly unknown[]).includes(name);
}

/** 角色文案的语言。主语言 `zh`；`zh`、`en` 都推荐提供。 */
export const CHARACTER_LOCALES = ['zh', 'en'] as const;
export type CharacterLocale = (typeof CHARACTER_LOCALES)[number];
export const PRIMARY_CHARACTER_LOCALE: CharacterLocale = 'zh';

/** 包内约定文件名。 */
export const PACK_FILES = {
  manifest: 'manifest.json',
  persona: 'persona.json',
  mapping: 'mapping.json',
  localesDir: 'locales',
  /** 旧版命中区文件；新包写在 manifest.layout 里 */
  legacyHitboxes: 'layout/hitboxes.json',
  /** 旧版文案目录（copy/{zh,en}.json），迁移到 locales/ */
  legacyCopyDir: 'copy',
  /** 旧版人设（persona/system-prompt.md），迁移到 persona.json */
  legacySystemPrompt: 'persona/system-prompt.md',
} as const;

export interface CharacterContractData {
  schema: number;
  contractVersion: number;
  rive: { artboard: string; stateMachine: string; fileName: string; nativeMotions: string[] };
  sprite: { actionIds: string[]; actionCount: number };
  voice: { locales: string[]; requiredClipIds: string[]; legacyKeyAlias: boolean };
  onboarding: { files: string[] };
  hitboxIds: string[];
  modes: string[];
  mapping: { emotions: string[]; activities: string[]; gestures: string[] };
  [key: string]: unknown;
}

export interface VoiceIdTable {
  schema: number;
  /** 旧 i18n key → 稳定 clip id */
  byLegacyKey: Record<string, string>;
  /** 稳定 clip id → 旧 i18n key（气泡文案查找用） */
  byId: Record<string, string>;
}

export const CONTRACT: Readonly<CharacterContractData> = contractJson as CharacterContractData;
export const VOICE_IDS: Readonly<VoiceIdTable> = voiceIdsJson as VoiceIdTable;
