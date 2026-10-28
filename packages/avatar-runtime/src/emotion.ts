import type { MascotExpression } from './MascotBackend';

/**
 * 回复情绪分析（纯函数，便于测试）：加权词典 + 否定词翻转 + 感叹号 / emoji 加强，
 * 最后一句权重更高（回复结尾的语气最能代表角色此刻的情绪）。
 */
export type Emotion = 'happy' | 'sad' | 'angry' | 'surprised' | 'neutral';

export interface EmotionResult {
  emotion: Emotion;
  /** 0..1 */
  intensity: number;
  /** 正面词被否定（如「不开心」） */
  negated: boolean;
}

const LEX: Record<Exclude<Emotion, 'neutral'>, Array<[RegExp, number]>> = {
  happy: [
    [/(太好了|太棒了|好开心|超开心|哈哈哈+|恭喜|耶[!！~～]?|🎉|😄|🥳)/gi, 1],
    [
      /(开心|高兴|喜欢|棒|厉害|哈哈|嘿嘿|谢谢|好耶|完美|awesome|great|glad|happy|yay|😊|✨|💖)/gi,
      0.6,
    ],
    [/(好的|没问题|当然|可以|sure|ok\b|nice)/gi, 0.3],
  ],
  sad: [
    [/(好难过|太遗憾|伤心|呜呜|😭)/gi, 1],
    [/(抱歉|对不起|遗憾|难过|可惜|失败|sorry|unfortunately|sad|😢|🥺)/gi, 0.6],
    [/(无法|不能|做不到|can't|cannot)/gi, 0.3],
  ],
  angry: [
    [/(气死|可恶|太过分|😡|🤬)/gi, 1],
    [/(生气|讨厌|哼[!！]|烦|angry|annoyed|😠)/gi, 0.6],
  ],
  surprised: [
    [/(天哪|竟然|居然|不会吧|真的假的|😱|😲|whoa)/gi, 0.9],
    [/(哇|诶[?？!！]|咦|wow|really\?|😮)/gi, 0.6],
  ],
};

const NEGATION = /(不|没|没有|别|并不|not |no |never )$/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?\n～~])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function analyzeEmotion(text: string | null | undefined): EmotionResult {
  const t = (text ?? '').slice(-2000);
  if (!t.trim()) return { emotion: 'neutral', intensity: 0, negated: false };
  const score: Record<Exclude<Emotion, 'neutral'>, number> = {
    happy: 0,
    sad: 0,
    angry: 0,
    surprised: 0,
  };
  let negated = false;
  const ss = sentences(t);
  ss.forEach((s, idx) => {
    const w = idx === ss.length - 1 ? 1.5 : 1;
    const bang = /[!！]{1,}/.test(s) ? 1.25 : 1;
    for (const [emo, rules] of Object.entries(LEX) as Array<
      [keyof typeof score, Array<[RegExp, number]>]
    >) {
      for (const [re, weight] of rules) {
        re.lastIndex = 0;
        for (let m = re.exec(s); m; m = re.exec(s)) {
          const before = s.slice(Math.max(0, m.index - 4), m.index);
          if (emo === 'happy' && NEGATION.test(before)) {
            score.sad += weight * w;
            negated = true;
          } else score[emo] += weight * w * bang;
        }
      }
    }
  });
  const best = (Object.entries(score) as Array<[Emotion, number]>).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 0.25) return { emotion: 'neutral', intensity: 0, negated };
  return { emotion: best[0], intensity: Math.min(1, best[1] / 2), negated };
}

export function expressionForEmotion(e: Emotion): MascotExpression {
  return e === 'neutral' ? 'neutral' : e;
}

/** 情绪 + 强度 → 身体动作 */
export function motionForEmotion(r: EmotionResult): string | undefined {
  const strong = r.intensity >= 0.7;
  switch (r.emotion) {
    case 'happy':
      return strong ? 'cheer' : r.intensity >= 0.35 ? 'clap' : 'nod';
    case 'sad':
      return strong ? 'bow' : 'shake';
    case 'angry':
      return 'shake';
    case 'surprised':
      return 'flinch';
    default:
      return undefined;
  }
}

/**
 * 流式回复期间的情绪追踪：累计增量文本，一旦出现足够强烈的情绪就提前反应一次
 * （不必等整段回复结束），并让结束时的反应避免重复同一个动作。
 */
export class StreamEmotionTracker {
  private buf = '';
  private early: EmotionResult | null = null;

  constructor(private readonly threshold = 0.6) {}

  reset(): void {
    this.buf = '';
    this.early = null;
  }

  /** 返回需要提前反应的情绪（每轮最多一次） */
  push(delta: string): EmotionResult | null {
    if (this.early) return null;
    this.buf += delta;
    if (this.buf.length < 4) return null;
    const r = analyzeEmotion(this.buf);
    if (r.emotion !== 'neutral' && r.intensity >= this.threshold) {
      this.early = r;
      return r;
    }
    return null;
  }

  /** 结束：返回早先是否已用同一情绪反应过 */
  finish(): EmotionResult | null {
    const e = this.early;
    this.reset();
    return e;
  }
}
