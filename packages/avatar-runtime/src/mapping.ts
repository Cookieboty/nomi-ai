/**
 * 语义 → 引擎资源（docs/design/core-host-decoupling.md §10.5）。
 *
 * AI 侧与宿主只发语义名（情绪、活动、手势，词表在 `@nomi-ai/character-contract`）；角色包的
 * `mapping.json` 把它们翻译成自己的表情与动作。没有映射的名字忽略。包没有 `mapping.json` 时用
 * 引擎的默认映射（与官方包 `characters/nomi/mapping.json` 相同，测试保证两者一致），这样只换了
 * 立绘、沿用内置骨架动作的旧包行为不变。
 *
 * 运行时同一页面只挂一个角色（见 MascotBackend 的注册表），当前映射也是全局一份。
 */
import {
  isSemanticActivity,
  isSemanticEmotion,
  isSemanticGesture,
  SEMANTIC_ACTIVITIES,
  SEMANTIC_EMOTIONS,
  SEMANTIC_GESTURES,
  type PackMapping,
  type SemanticActivity,
  type SemanticEmotion,
  type SemanticGesture,
} from '@nomi-ai/character-contract';

/** 引擎默认映射：内置 Rive / 分层 2D 骨架的表情与动作名。 */
export const DEFAULT_AVATAR_MAPPING: Readonly<Required<PackMapping>> = {
  emotions: {
    neutral: 'neutral',
    happy: 'happy',
    sad: 'sad',
    angry: 'angry',
    surprised: 'surprised',
    relaxed: 'relaxed',
  },
  activities: {
    thinking: 'think',
    toolRunning: 'work',
  },
  gestures: {
    wave: 'wave',
    greet: 'hello',
    nod: 'nod',
    shakeHead: 'shake',
    bow: 'bow',
    salute: 'salute',
    pray: 'pray',
    okHand: 'ok_hand',
    think: 'think',
    explain: 'explain',
    eureka: 'eureka',
    puzzled: 'puzzled',
    listen: 'listen',
    lookAround: 'look_around',
    lookLeftRight: 'look_lr',
    peek: 'peek',
    heart: 'heart',
    blowKiss: 'blow_kiss',
    shy: 'shy',
    coverFace: 'cover_face',
    apologize: 'sorry',
    surprise: 'surprise',
    startle: 'flinch',
    sigh: 'sigh',
    smug: 'smug',
    aggrieved: 'aggrieved',
    tears: 'tears',
    angry: 'angry',
    coldSweat: 'cold_sweat',
    daze: 'daze',
    cheer: 'cheer',
    thumbsUp: 'thumbs_up',
    peace: 'peace',
    celebrate: 'celebrate',
    clap: 'clap',
    hop: 'hop',
    wink: 'wink',
    tongue: 'tongue',
    cute: 'cute',
    reachOut: 'interact',
    work: 'work',
    yawn: 'yawn',
    stretch: 'stretch',
    goodnight: 'goodnight',
    hum: 'peek_note',
    random: 'random',
  },
};

let active: PackMapping = DEFAULT_AVATAR_MAPPING;

/**
 * 设置当前角色的映射；`null` / `undefined`（包没有 mapping.json）用引擎默认映射。
 * 返回值恢复成默认映射（卸载时调用）。
 */
export function setAvatarMapping(mapping: PackMapping | null | undefined): () => void {
  const next = mapping ?? DEFAULT_AVATAR_MAPPING;
  active = next;
  return () => {
    if (active === next) active = DEFAULT_AVATAR_MAPPING;
  };
}

export function currentAvatarMapping(): PackMapping {
  return active;
}

function pick(target: string | string[] | undefined, rand: () => number): string | null {
  if (target === undefined) return null;
  if (typeof target === 'string') return target || null;
  if (target.length === 0) return null;
  return target[Math.floor(rand() * target.length)] ?? null;
}

/** 语义情绪 → 包的表情；不是词表里的名字或没有映射时返回 null。 */
export function emotionTarget(name: string, rand: () => number = Math.random): string | null {
  return isSemanticEmotion(name) ? pick(active.emotions?.[name], rand) : null;
}

/** 语义活动 → 保持姿态的动作（`idle` 没有资源，返回 null）。 */
export function activityTarget(name: string, rand: () => number = Math.random): string | null {
  return isSemanticActivity(name) ? pick(active.activities?.[name], rand) : null;
}

/** 语义手势 → 包的动作。 */
export function gestureTarget(name: string, rand: () => number = Math.random): string | null {
  return isSemanticGesture(name) ? pick(active.gestures?.[name], rand) : null;
}

/** 当前角色能表现的语义名（有映射的），宿主据此报告场景（`scene` 输出）。 */
export interface AvatarSemanticCapabilities {
  emotions: SemanticEmotion[];
  activities: SemanticActivity[];
  gestures: SemanticGesture[];
}

export function mappedSemantics(mapping: PackMapping = active): AvatarSemanticCapabilities {
  const has = (v: string | string[] | undefined) => (Array.isArray(v) ? v.length > 0 : !!v);
  return {
    emotions: SEMANTIC_EMOTIONS.filter((n) => has(mapping.emotions?.[n])),
    activities: SEMANTIC_ACTIVITIES.filter((n) => n === 'idle' || has(mapping.activities?.[n])),
    gestures: SEMANTIC_GESTURES.filter((n) => has(mapping.gestures?.[n])),
  };
}
