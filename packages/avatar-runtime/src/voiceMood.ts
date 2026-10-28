/** 语音状态 → 角色表情 / 动作（纯函数，便于测试） */
import type { ExpressionDirective } from './expressionDirector';

export function voiceDirective(phase: string, prev: string): ExpressionDirective | null {
  if (phase === prev) return null;
  switch (phase) {
    case 'recording':
    case 'hearing':
      return {
        expression: 'relaxed',
        holdMs: 0,
        motion: prev === 'idle' || prev === 'listening' ? 'nod' : undefined,
      };
    case 'transcribing':
      return { expression: 'neutral', holdMs: 0, motion: 'think' };
    case 'awake':
      return { expression: 'happy', holdMs: 2500, motion: 'wave' };
    case 'idle':
    case 'listening':
    case 'wake-armed':
      return prev === 'idle' ? null : { expression: 'neutral', holdMs: 0 };
    default:
      return null;
  }
}
