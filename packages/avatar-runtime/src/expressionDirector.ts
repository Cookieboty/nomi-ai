import { analyzeEmotion, motionForEmotion, type EmotionResult } from './emotion';
import type { MascotExpression } from './MascotBackend';

/**
 * 根据聊天/TTS 事件决定看板娘表情（纯函数，便于测试）。
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

/** 文本 → 配合的身体动作（可无） */
const MOTION_RULES: Array<{ motion: string; re: RegExp }> = [
  { motion: 'wave', re: /(你好|您好|嗨|早上好|晚上好|再见|拜拜|\bhello\b|\bhi\b|\bbye\b|👋)/i },
  { motion: 'bow', re: /(抱歉|对不起|不好意思|谢谢|感谢|sorry|thank you|thanks)/i },
  { motion: 'cheer', re: /(太好了|恭喜|成功了|耶|hooray|congrat|🎉)/i },
  { motion: 'think', re: /(让我想想|我想想|思考|嗯…|hmm|let me think)/i },
];

const EXPRESSION_MOTION: Partial<Record<MascotExpression, string>> = {
  happy: 'nod',
  angry: 'shake',
  sad: 'shake',
  surprised: 'flinch',
};

export function motionForText(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  for (const { motion, re } of MOTION_RULES) {
    if (re.test(text)) return motion;
  }
  return EXPRESSION_MOTION[expressionForText(text)];
}

export type MascotEvent =
  | { kind: 'agent:step' }
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
  /** 工具正在运行（写代码 / 执行命令） */
  | { kind: 'tool:running' }
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
  expression: MascotExpression;
  /** 持续时间（ms）；到期回到 neutral。0 = 保持。 */
  holdMs: number;
  /** 可选的身体动作（由 mood.applyDirective 节流播放） */
  motion?: string;
  /** 打断类反应：不受自动动作冷却限制，立即播放 */
  force?: boolean;
  /** 动作优先级（2D 骨架）：0 空闲 · 1 普通 · 2 反应 · 3 任务事件 */
  priority?: 0 | 1 | 2 | 3;
  /** 保持动作姿态直到被新动作替换（思考 / 工作） */
  hold?: boolean;
}

/** 长回答（讲解）阈值：字符数 */
export const LONG_ANSWER_CHARS = 280;

export function directiveForEvent(evt: MascotEvent): ExpressionDirective | null {
  switch (evt.kind) {
    case 'agent:step':
      return { expression: 'relaxed', holdMs: 4000, motion: 'think', hold: true, priority: 1 };
    case 'tool:running':
      return { expression: 'relaxed', holdMs: 4000, motion: 'work', hold: true, priority: 1 };
    case 'task:done':
      return {
        expression: 'happy',
        holdMs: 4000,
        motion: evt.all ? 'celebrate' : 'thumbs_up',
        priority: 3,
        force: true,
      };
    case 'task:failed':
      return { expression: 'sad', holdMs: 4500, motion: 'sorry', priority: 3, force: true };
    case 'greeting':
      return { expression: 'happy', holdMs: 3000, motion: 'wave', priority: 1, force: true };
    case 'night':
      return { expression: 'relaxed', holdMs: 0, motion: 'goodnight', hold: true, priority: 1 };
    case 'file:drop':
      return {
        expression: 'surprised',
        holdMs: 1500,
        motion: 'surprise',
        priority: 2,
        force: true,
      };
    case 'message:delta':
      return { expression: 'relaxed', holdMs: 4000 };
    case 'message:complete': {
      const a = analyzeEmotion(evt.text);
      // 强烈情绪升级动作（如「太好了！！」→ 欢呼），否则用关键词动作
      const motion =
        a.intensity >= 0.7
          ? (motionForEmotion(a) ?? motionForText(evt.text))
          : motionForText(evt.text);
      // 没有更具体的动作（或只是默认点头）时，长回答用「讲解」姿态
      const long = (evt.text?.length ?? 0) >= LONG_ANSWER_CHARS;
      return {
        expression: expressionForText(evt.text),
        holdMs: a.intensity >= 0.7 ? 5000 : 3500,
        motion: long && (!motion || motion === 'nod') ? 'explain' : motion,
      };
    }
    case 'message:early':
      return {
        expression: evt.emotion.emotion === 'neutral' ? 'relaxed' : evt.emotion.emotion,
        holdMs: 4000,
        motion: motionForEmotion(evt.emotion),
      };
    case 'barge-in':
      return { expression: 'surprised', holdMs: 1200, motion: 'flinch', force: true };
    case 'voice:wake':
      return { expression: 'happy', holdMs: 2000, motion: 'nod' };
    case 'stopped-by-user':
      return { expression: 'neutral', holdMs: 0, motion: 'nod', force: true };
    case 'confirm-required':
      return { expression: 'relaxed', holdMs: 0, motion: 'interact' };
    case 'tool:executed':
      return evt.ok
        ? { expression: 'happy', holdMs: 1500, motion: 'nod' }
        : { expression: 'sad', holdMs: 3000, motion: 'shake' };
    case 'error':
      return { expression: 'sad', holdMs: 3500, motion: 'shake' };
    case 'tts:end':
      return null;
    default:
      return null;
  }
}
