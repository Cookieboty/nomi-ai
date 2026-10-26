import { getActiveCharacter, saveCharacterVoice, speakForActiveCharacter } from './characterVoice';
import { MASCOT_EXPRESSIONS, type MascotExpression } from './MascotBackend';
import { applyDirective, playMotionNow } from './mood';

/** 新手引导里可选的声音风格（作用于当前角色的 TTS；off = 关闭语音） */
export const VOICE_STYLES = {
  // 语速统一在「实时朗读引擎」里设置（一个语速），这里只保留音调偏好
  soft: { pitch: 1.1 },
  lively: { pitch: 1.25 },
  calm: { pitch: 0.95 },
} as const;
export type VoiceStyle = keyof typeof VOICE_STYLES | 'off';

/** 主进程（AI 工具 / 托盘）或渲染进程内部发来的看板娘指令 */
export type MascotCommand =
  | { type: 'motion'; name: string }
  | { type: 'expression'; name: string }
  | { type: 'open-panel'; panel: string }
  | { type: string; [k: string]: unknown };

/** 执行指令；返回是否被识别并执行。 */
export function handleMascotCommand(raw: unknown): boolean {
  const cmd = raw as MascotCommand | null;
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return false;
  switch (cmd.type) {
    case 'motion':
      return typeof cmd.name === 'string' && playMotionNow(cmd.name);
    case 'expression': {
      const name = String(cmd.name ?? '').toLowerCase() as MascotExpression;
      if (!MASCOT_EXPRESSIONS.includes(name)) return false;
      applyDirective({ expression: name, holdMs: name === 'neutral' ? 0 : 5000 });
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
      if (typeof cmd.motion === 'string') playMotionNow(cmd.motion);
      return true;
    }
    case 'voice-style': {
      const style = cmd.style as VoiceStyle;
      if (style !== 'off' && !(style in VOICE_STYLES)) return false;
      window.dispatchEvent(
        new CustomEvent('mascot:voice-enabled', { detail: { enabled: style !== 'off' } }),
      );
      if (style === 'off') return true;
      const { name, config } = getActiveCharacter();
      const preview = typeof cmd.preview === 'string' ? cmd.preview.slice(0, 120) : '';
      const speak = () => preview && speakForActiveCharacter(preview);
      if (name)
        void saveCharacterVoice(name, { ...VOICE_STYLES[style] }, config)
          .catch(() => undefined)
          .finally(speak);
      else speak();
      return true;
    }
    case 'reply-speech':
      // 朗读 AI 回复（对话窗口 → 主进程 tts:reply → 这里）
      void import('./tts/replySpeech').then((m) => m.handleReplySpeech(cmd));
      return true;
    default:
      return false;
  }
}
