/**
 * 语义事件 → 当前后端（口型、说话姿态、表情、动作）。
 *
 * 原来分散在 renderer 的 MascotDriver（TTS 口型）、MascotAIBridge（对话 / 工具事件）、看板娘指令
 * （显式动作 / 表情）与语音桥里；现在宿主只把事件翻译成 `AvatarEvent`，决策都在这里。
 */
import { isSemanticEmotion } from '@nomi-ai/character-contract';

import { StreamEmotionTracker } from './emotion';
import type { AvatarEvent, AvatarEventSource } from './events';
import { directiveForActivity, directiveForEvent } from './expressionDirector';
import { mascotRegistry } from './MascotBackend';
import { applyDirective, playGesture, playMotionNow } from './mood';
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

/** 显式语义情绪：不在词表里的忽略；返回是否执行（没有映射时执行了也不会变表情） */
export function applyEmotion(raw: string, weight?: number): boolean {
  const name = String(raw ?? '');
  if (!isSemanticEmotion(name)) return false;
  const w = typeof weight === 'number' && Number.isFinite(weight) ? weight : undefined;
  applyDirective({
    // 情绪名经映射成为表情；没有映射的（例如官方包的 shy）不变表情
    expression: name,
    holdMs: name === 'neutral' ? 0 : 5000,
    ...(w === undefined ? {} : { weight: Math.max(0, Math.min(1, w)) }),
  });
  return true;
}

/** 语义活动：thinking / toolRunning 保持姿态，idle 结束保持的姿态 */
export function applyActivity(name: string): boolean {
  if (name === 'idle') {
    releaseHeldMotion();
    return true;
  }
  if (name !== 'thinking' && name !== 'toolRunning') return false;
  applyDirective(directiveForActivity(name));
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
          // 中途已经用同一情绪做过手势 → 结尾只保持表情，不重复动作
          if (d && early && early.emotion === d.expression) delete d.gesture;
          applyDirective(d);
        } else if (e.phase === 'waiting' || e.phase === 'settled') {
          // 引擎控制（不是包资源）：分层 2D 骨架保持 / 放下思考的神态，其它后端忽略
          playMotionNow(e.phase === 'waiting' ? 'think-on' : 'think-off');
        } else {
          tracker.reset();
          releaseHeldMotion();
          applyDirective(directiveForEvent({ kind: 'stopped-by-user' }));
        }
        return;
      case 'emotion':
        applyEmotion(e.name, e.weight);
        return;
      case 'gesture':
        playGesture(e.name);
        return;
      case 'activity':
        applyActivity(e.name);
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
