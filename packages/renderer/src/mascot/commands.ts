import { MASCOT_EXPRESSIONS, type MascotExpression } from '@nomi-ai/avatar-runtime';

import { avatarEvents } from '../avatar/events';

/** 主进程（AI 工具 / 托盘）或渲染进程内部发来的看板娘指令 */
export type MascotCommand =
  | { type: 'motion'; name: string }
  | { type: 'expression'; name: string }
  | { type: 'open-panel'; panel: string }
  | { type: string; [k: string]: unknown };

/** 执行指令；返回是否被识别。动作 / 表情转成语义事件交给 avatar-runtime。 */
export function handleMascotCommand(raw: unknown): boolean {
  const cmd = raw as MascotCommand | null;
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return false;
  switch (cmd.type) {
    case 'motion':
      if (typeof cmd.name !== 'string') return false;
      avatarEvents.emit({ type: 'gesture', name: cmd.name });
      return true;
    case 'expression': {
      const name = String(cmd.name ?? '').toLowerCase() as MascotExpression;
      if (!MASCOT_EXPRESSIONS.includes(name)) return false;
      avatarEvents.emit({ type: 'emotion', name });
      return true;
    }
    case 'open-panel':
      if (typeof cmd.panel !== 'string') return false;
      window.dispatchEvent(new CustomEvent('mascot:open-panel', { detail: { panel: cmd.panel } }));
      return true;
    case 'say': {
      // 新手引导等：在气泡里说一句（可附带动作）
      if (typeof cmd.text !== 'string' || !cmd.text) return false;
      window.dispatchEvent(
        new CustomEvent('mascot:say', {
          detail: { text: cmd.text.slice(0, 200), ms: 6000, priority: 10 },
        }),
      );
      if (typeof cmd.motion === 'string') avatarEvents.emit({ type: 'gesture', name: cmd.motion });
      return true;
    }
    case 'reply-speech': {
      // 朗读 AI 回复（对话窗口 → 主进程 tts:reply → 这里）
      // 从宽的 MascotCommand 收窄成 ReplySpeechMessage，避免 TS2559
      const msg = { op: cmd.op, id: cmd.id, text: cmd.text };
      void import('./tts/replySpeech').then((m) => m.handleReplySpeech(msg));
      return true;
    }
    default:
      return false;
  }
}
