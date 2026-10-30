import type {
  SemanticActivity,
  SemanticEmotion,
  SemanticGesture,
} from '@nomi-ai/character-contract';

import { analyzeEmotion, gestureForEmotion, type EmotionResult } from './emotion';
import type { MascotExpression } from './MascotBackend';

/**
 * 根据聊天 / TTS 事件决定桌面角色的情绪与手势（纯函数，便于测试）。
 * 输出只有语义名（§10.5），由 mapping.ts 按当前角色包翻译成表情与动作。
 */

const RULES: Array<{ expr: MascotExpression; re: RegExp }> = [
  { expr: 'angry', re: /(生气|气死|可恶|讨厌|哼[!！]|angry|annoyed|furious|😠|😡)/i },
  {
    expr: 'sad',
    re: /(抱歉|对不起|遗憾|难过|伤心|失败|无法|不能|sorry|unfortunately|sad|can't|cannot|😢|😭)/i,
  },
  { expr: 'surprised', re: /(哇|诶[?？!！]|竟然|居然|wow|whoa|really\?|😮|😲)/i },
  {
    expr: 'happy',
    re: /(哈哈|开心|太好了|好的|当然|没问题|恭喜|谢谢|加油|great|awesome|glad|happy|sure|done|✨|😊|😄|🎉)/i,
  },
];

export function expressionForText(text: string | null | undefined): MascotExpression {
  if (!text) return 'neutral';
  // 「不开心」「没有很高兴」之类：正面词被否定 → 不能笑
  const a = analyzeEmotion(text);
  if (a.negated && a.emotion === 'sad') return 'sad';
  for (const { expr, re } of RULES) {
    if (re.test(text)) return expr;
  }
  return 'happy';
}

/** 文本 → 配合的手势（可无） */
const GESTURE_RULES: Array<{ gesture: SemanticGesture; re: RegExp }> = [
  { gesture: 'wave', re: /(你好|您好|嗨|早上好|晚上好|再见|拜拜|\bhello\b|\bhi\b|\bbye\b|👋)/i },
  { gesture: 'bow', re: /(抱歉|对不起|不好意思|谢谢|感谢|sorry|thank you|thanks)/i },
  { gesture: 'cheer', re: /(太好了|恭喜|成功了|耶|hooray|congrat|🎉)/i },
  { gesture: 'think', re: /(让我想想|我想想|思考|嗯…|hmm|let me think)/i },
];

const EXPRESSION_GESTURE: Partial<Record<MascotExpression, SemanticGesture>> = {
  happy: 'nod',
  angry: 'shakeHead',
  sad: 'shakeHead',
  surprised: 'startle',
};

export function gestureForText(text: string | null | undefined): SemanticGesture | undefined {
  if (!text) return undefined;
  for (const { gesture, re } of GESTURE_RULES) {
    if (re.test(text)) return gesture;
  }
  return EXPRESSION_GESTURE[expressionForText(text)];
}

export type MascotEvent =
  | { kind: 'message:delta' }
  | { kind: 'message:complete'; text?: string }
  | { kind: 'tool:executed'; ok: boolean }
  | { kind: 'error' }
  | { kind: 'tts:end' }
  /** 流式回复中途出现的强烈情绪 */
  | { kind: 'message:early'; emotion: EmotionResult }
  /** 用户开口打断了正在朗读的回复 */
  | { kind: 'barge-in' }
  /** 唤醒词 + 指令一句说完 */
  | { kind: 'voice:wake' }
  /** 用户点了停止生成 */
  | { kind: 'stopped-by-user' }
  /** 智能体在等用户确认一个操作 */
  | { kind: 'confirm-required' }
  /** 一轮任务完成 / 全部完成 / 失败 */
  | { kind: 'task:done'; all?: boolean }
  | { kind: 'task:failed' }
  /** 问候（早安 / 首次打开） */
  | { kind: 'greeting' }
  /** 深夜 / 长时间无操作 */
  | { kind: 'night' }
  /** 用户把文件拖到她身上 */
  | { kind: 'file:drop' };

export interface ExpressionDirective {
  /** 语义情绪（经映射成为表情） */
  expression: SemanticEmotion;
  /** 表情强度 0..1（缺省 1） */
  weight?: number;
  /** 持续时间（ms）；到期回到 neutral。0 = 保持。 */
  holdMs: number;
  /** 可选的语义手势（经映射成为动作，由 mood.applyDirective 节流播放） */
  gesture?: SemanticGesture;
  /** 可选的语义活动（经映射成为保持姿态的动作）；与 gesture 二选一 */
  activity?: Exclude<SemanticActivity, 'idle'>;
  /** 打断类反应：不受自动动作冷却限制，立即播放 */
  force?: boolean;
  /** 动作优先级（2D 骨架）：0 空闲 · 1 普通 · 2 反应 · 3 任务事件 */
  priority?: 0 | 1 | 2 | 3;
  /** 保持动作姿态直到被新动作替换（思考 / 工作） */
  hold?: boolean;
}

/** 长回答（讲解）阈值：字符数 */
export const LONG_ANSWER_CHARS = 280;

/** 活动状态（AI 在思考 / 工具在运行）：放松的表情 + 保持姿态的动作，直到被新动作替换 */
export function directiveForActivity(
  activity: Exclude<SemanticActivity, 'idle'>,
): ExpressionDirective {
  return { expression: 'relaxed', holdMs: 4000, activity, hold: true, priority: 1 };
}

export function directiveForEvent(evt: MascotEvent): ExpressionDirective | null {
  switch (evt.kind) {
    case 'task:done':
      return {
        expression: 'happy',
        holdMs: 4000,
        gesture: evt.all ? 'celebrate' : 'thumbsUp',
        priority: 3,
        force: true,
      };
    case 'task:failed':
      return { expression: 'sad', holdMs: 4500, gesture: 'apologize', priority: 3, force: true };
    case 'greeting':
      return { expression: 'happy', holdMs: 3000, gesture: 'wave', priority: 1, force: true };
    case 'night':
      return { expression: 'relaxed', holdMs: 0, gesture: 'goodnight', hold: true, priority: 1 };
    case 'file:drop':
      return {
        expression: 'surprised',
        holdMs: 1500,
        gesture: 'surprise',
        priority: 2,
        force: true,
      };
    case 'message:delta':
      return { expression: 'relaxed', holdMs: 4000 };
    case 'message:complete': {
      const a = analyzeEmotion(evt.text);
      // 强烈情绪升级动作（如「太好了！！」→ 欢呼），否则用关键词动作
      const gesture =
        a.intensity >= 0.7
          ? (gestureForEmotion(a) ?? gestureForText(evt.text))
          : gestureForText(evt.text);
      // 没有更具体的动作（或只是默认点头）时，长回答用「讲解」姿态
      const long = (evt.text?.length ?? 0) >= LONG_ANSWER_CHARS;
      return {
        expression: expressionForText(evt.text),
        holdMs: a.intensity >= 0.7 ? 5000 : 3500,
        gesture: long && (!gesture || gesture === 'nod') ? 'explain' : gesture,
      };
    }
    case 'message:early':
      return {
        expression: evt.emotion.emotion === 'neutral' ? 'relaxed' : evt.emotion.emotion,
        holdMs: 4000,
        gesture: gestureForEmotion(evt.emotion),
      };
    case 'barge-in':
      return { expression: 'surprised', holdMs: 1200, gesture: 'startle', force: true };
    case 'voice:wake':
      return { expression: 'happy', holdMs: 2000, gesture: 'nod' };
    case 'stopped-by-user':
      return { expression: 'neutral', holdMs: 0, gesture: 'nod', force: true };
    case 'confirm-required':
      return { expression: 'relaxed', holdMs: 0, gesture: 'reachOut' };
    case 'tool:executed':
      return evt.ok
        ? { expression: 'happy', holdMs: 1500, gesture: 'nod' }
        : { expression: 'sad', holdMs: 3000, gesture: 'shakeHead' };
    case 'error':
      return { expression: 'sad', holdMs: 3500, gesture: 'shakeHead' };
    case 'tts:end':
      return null;
    default:
      return null;
  }
}
