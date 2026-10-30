/** 语音状态 → 角色情绪 / 手势（纯函数，便于测试；输出语义名，经 mapping 翻译） */
import type { ExpressionDirective } from './expressionDirector';

export function voiceDirective(phase: string, prev: string): ExpressionDirective | null {
  if (phase === prev) return null;
  switch (phase) {
    case 'recording':
    case 'hearing':
      return {
        expression: 'relaxed',
        holdMs: 0,
        gesture: prev === 'idle' || prev === 'listening' ? 'nod' : undefined,
      };
    case 'transcribing':
      return { expression: 'neutral', holdMs: 0, gesture: 'think' };
    case 'awake':
      return { expression: 'happy', holdMs: 2500, gesture: 'wave' };
    case 'idle':
    case 'listening':
    case 'wake-armed':
      return prev === 'idle' ? null : { expression: 'neutral', holdMs: 0 };
    default:
      return null;
  }
}
