/**
 * 语义事件 → 当前后端（口型、说话姿态、表情、动作）。
 *
 * 原来分散在 renderer 的 MascotDriver（TTS 口型）、MascotAIBridge（对话 / 工具事件）、看板娘指令
 * （显式动作 / 表情）与语音桥里；现在宿主只把事件翻译成 `AvatarEvent`，决策都在这里。
 */
import { StreamEmotionTracker } from './emotion';
import type { AvatarEvent, AvatarEventSource } from './events';
import { directiveForEvent } from './expressionDirector';
import { MASCOT_EXPRESSIONS, mascotRegistry, type MascotExpression } from './MascotBackend';
import { applyDirective, playMotionNow } from './mood';
import { voiceDirective } from './voiceMood';

/** 口型包络超过它算在说话 */
export const TALK_RMS = 0.04;
/** 安静这么久后才退出说话姿态 */
export const TALK_RELEASE_MS = 1200;

/** 结束保持姿态的动作（托腮思考 / 打字工作）；仅 2D 骨架支持 */
function releaseHeldMotion(): void {
  const b = mascotRegistry.current();
  if (b?.kind === 'sprite') b.playMotion('release');
}

/** 显式表情：不在表情表里的忽略；返回是否执行 */
export function applyEmotion(raw: string): boolean {
  const name = String(raw ?? '').toLowerCase() as MascotExpression;
  if (!MASCOT_EXPRESSIONS.includes(name)) return false;
  applyDirective({ expression: name, holdMs: name === 'neutral' ? 0 : 5000 });
  return true;
}

/**
 * 订阅事件源并驱动当前挂载的后端；返回值停止驱动（清掉说话计时器）。
 * 同一时刻只应有一个驱动（后端注册表是全局唯一的）。
 */
export function driveAvatar(source: AvatarEventSource): () => void {
  let talking = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const tracker = new StreamEmotionTracker();

  const onSpeaking = (rms: number): void => {
    const backend = mascotRegistry.current();
    backend?.setMouthOpen(rms);
    if (rms > TALK_RMS) {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = null;
      if (!talking) {
        talking = true;
        backend?.setTalking(true);
      }
    } else if (talking && !silenceTimer) {
      silenceTimer = setTimeout(() => {
        talking = false;
        silenceTimer = null;
        mascotRegistry.current()?.setTalking(false);
      }, TALK_RELEASE_MS);
    }
  };

  const handle = (e: AvatarEvent): void => {
    switch (e.type) {
      case 'speaking':
        onSpeaking(e.level);
        return;
      case 'cue':
        applyDirective(directiveForEvent(e.cue));
        return;
      case 'reply':
        if (e.phase === 'delta') {
          const early = tracker.push(e.text);
          applyDirective(
            directiveForEvent(
              early ? { kind: 'message:early', emotion: early } : { kind: 'message:delta' },
            ),
          );
        } else if (e.phase === 'complete') {
          const early = tracker.finish();
          releaseHeldMotion();
          const d = directiveForEvent({ kind: 'message:complete', text: e.text });
          // 中途已经用同一情绪做过动作 → 结尾只保持表情，不重复动作
          if (d && early && early.emotion === d.expression) delete d.motion;
          applyDirective(d);
        } else {
          tracker.reset();
          releaseHeldMotion();
          applyDirective(directiveForEvent({ kind: 'stopped-by-user' }));
        }
        return;
      case 'emotion':
        applyEmotion(e.name);
        return;
      case 'gesture':
        playMotionNow(e.name);
        return;
      case 'voice': {
        const d = voiceDirective(e.phase, e.prev);
        if (d) applyDirective(d);
        return;
      }
      default:
        // cursor / physics：由交互层（InteractionLite）自己订阅
        return;
    }
  };

  const off = source.subscribe(handle);
  return () => {
    off();
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
  };
}
