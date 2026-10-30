import {
  ToolRegistryKey,
  definePlugin,
  type PluginContext,
  type ToolDefinition,
} from '@nomi-ai/bundle-ig-base';
import {
  SEMANTIC_EMOTIONS,
  SEMANTIC_GESTURES,
  type SemanticEmotion,
  type SemanticGesture,
} from '@nomi-ai/character-contract';
import { z } from 'zod';

import { AvatarKey, type AvatarService } from '../seams/avatar';

export interface CompanionToolsPluginConfig {
  /** 为 true 时工具标记 dangerous=false（免 UI 确认），默认 true */
  autoConfirm?: boolean;
}

/**
 * 语义手势的说明（给模型看）。只描述语义，不是任何角色的动作名：角色包的 mapping.json
 * 决定实际播哪个动作，没有映射的手势被忽略（docs/design/core-host-decoupling.md §10.5）。
 */
const GESTURE_HINTS: Record<SemanticGesture, string> = {
  wave: '挥手',
  greet: '打招呼',
  nod: '点头',
  shakeHead: '摇头',
  bow: '鞠躬',
  salute: '敬礼',
  pray: '双手合十',
  okHand: 'OK 手势',
  think: '托腮思考',
  explain: '讲解',
  eureka: '灵光一闪',
  puzzled: '疑惑歪头',
  listen: '倾听',
  lookAround: '张望',
  lookLeftRight: '左顾右盼',
  peek: '偷看',
  heart: '比心',
  blowKiss: '送飞吻',
  shy: '害羞',
  coverFace: '捂脸',
  apologize: '道歉',
  surprise: '惊讶',
  startle: '吓一跳',
  sigh: '叹气',
  smug: '得意',
  aggrieved: '委屈',
  tears: '流泪',
  angry: '生气',
  coldSweat: '冷汗',
  daze: '发呆',
  cheer: '加油握拳',
  thumbsUp: '点赞',
  peace: '剪刀手',
  celebrate: '庆祝',
  clap: '鼓掌',
  hop: '开心跳动',
  wink: '眨眼',
  tongue: '吐舌',
  cute: '卖萌',
  reachOut: '伸手示意',
  work: '打字工作',
  yawn: '打哈欠',
  stretch: '伸懒腰',
  goodnight: '晚安',
  hum: '哼歌',
  random: '随机',
};

export const gestureInputSchema = z
  .object({
    name: z.enum(SEMANTIC_GESTURES),
  })
  .strict();

export type GestureInput = z.infer<typeof gestureInputSchema>;

export const emotionInputSchema = z
  .object({
    name: z.enum(SEMANTIC_EMOTIONS),
    /** 强度 0..1，缺省 1 */
    weight: z.number().min(0).max(1).optional(),
  })
  .strict();

export type EmotionInput = z.infer<typeof emotionInputSchema>;

export function createGestureTool(
  avatar: AvatarService,
  opts: { dangerous: boolean },
): ToolDefinition<GestureInput, { ok: true }> {
  const list = SEMANTIC_GESTURES.map((g) => `${g}（${GESTURE_HINTS[g]}）`).join('、');
  return {
    name: 'avatar_gesture',
    description:
      `让桌面角色做一个手势。name 为语义手势：${list}。` + '当前角色没有对应动作的手势会被忽略。',
    input: gestureInputSchema,
    dangerous: opts.dangerous,
    async execute(input: GestureInput) {
      const parsed = gestureInputSchema.parse(input);
      await avatar.gesture(parsed.name);
      return { ok: true } as const;
    },
  };
}

export function createEmotionTool(
  avatar: AvatarService,
  opts: { dangerous: boolean },
): ToolDefinition<EmotionInput, { ok: true }> {
  const list = SEMANTIC_EMOTIONS.join(' / ');
  return {
    name: 'avatar_emotion',
    description:
      `切换桌面角色的情绪：${list}（weight 0~1 为强度，数秒后自动恢复）。` +
      '当前角色没有对应表情的情绪会被忽略。',
    input: emotionInputSchema,
    dangerous: opts.dangerous,
    async execute(input: EmotionInput) {
      const parsed = emotionInputSchema.parse(input);
      await avatar.emotion(parsed.name as SemanticEmotion, parsed.weight);
      return { ok: true } as const;
    },
  };
}

export const CompanionToolsPlugin = definePlugin<CompanionToolsPluginConfig>({
  name: 'CompanionToolsPlugin',
  requires: ['AvatarSeamPlugin', 'ToolsBuiltinPlugin'],
  apply(ctx: PluginContext, cfg: CompanionToolsPluginConfig) {
    const avatar = ctx.inject(AvatarKey);
    if (!avatar) {
      ctx.logger.warn('[CompanionToolsPlugin] ctx.avatar not available; skipping');
      return;
    }
    const registry = ctx.inject(ToolRegistryKey);
    if (!registry) {
      ctx.logger.warn('[CompanionToolsPlugin] ctx.tools not available; skipping');
      return;
    }

    const dangerous = !(cfg.autoConfirm ?? true);

    registry.register(createGestureTool(avatar, { dangerous }));
    registry.register(createEmotionTool(avatar, { dangerous }));

    ctx.logger.info(
      `CompanionToolsPlugin ready (dangerous=${dangerous}, tools=avatar_gesture,avatar_emotion)`,
    );
  },
});
