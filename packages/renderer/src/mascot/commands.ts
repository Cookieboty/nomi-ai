import { avatarEvents } from '../avatar/events';

/**
 * 主进程（托盘 / 服务）发来的桌面角色指令：打开面板、说一句（可带语义手势）、朗读回复。
 * 角色的情绪 / 手势 / 活动不是指令，走语义事件 `avatar.event`（MascotDriver 直接转给运行时）。
 */
export type MascotCommand =
  | { type: 'open-panel'; panel: string }
  | { type: 'say'; text: string; gesture?: string }
  | { type: string; [k: string]: unknown };

/** 执行指令；返回是否被识别。 */
export function handleMascotCommand(raw: unknown): boolean {
  const cmd = raw as MascotCommand | null;
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return false;
  switch (cmd.type) {
    case 'open-panel':
      if (typeof cmd.panel !== 'string') return false;
      window.dispatchEvent(new CustomEvent('mascot:open-panel', { detail: { panel: cmd.panel } }));
      return true;
    case 'say': {
      // 新手引导等：在气泡里说一句（可附带语义手势）
      if (typeof cmd.text !== 'string' || !cmd.text) return false;
      window.dispatchEvent(
        new CustomEvent('mascot:say', {
          detail: { text: cmd.text.slice(0, 200), ms: 6000, priority: 10 },
        }),
      );
      if (typeof cmd.gesture === 'string')
        avatarEvents.emit({ type: 'gesture', name: cmd.gesture });
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
