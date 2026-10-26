/**
 * TTS playback in the renderer (any main-process engine returning audio via IPC).
 * Calls main `tts:speak`, plays returned audio, drives lipSyncStore RMS when possible.
 * On failure returns false; callers keep the request silent when no TTS is available.
 * No preview / upload-clone UI — character binding uses built-in referenceId (e.g. nomi).
 */

import { createLogger } from '@nomi-ai/ui';

import { lipSyncStore } from '../../ai/lipSyncStore';
import { stopSoftSpeech } from '../softSpeech';
import { registerSpeechStopper } from '../speechStop';

const log = createLogger('fish-speak');

export interface FishSpeakOptions {
  referenceId?: string;
  volume?: number;
  speed?: number;
  onEnd?: () => void;
}

/**
 * 每一句 TTS 拥有自己的一组资源（audio / blob url / 音频图 / RAF）。
 * 旧请求晚到失败时只能释放自己的 session，不能碰正在播放的新句（#47）。
 */
interface Session {
  audio: HTMLAudioElement | null;
  url: string | null;
  graph: { source: AudioNode; analyser: AudioNode } | null;
  raf: number;
}

let generation = 0;
/** 当前拥有播放权的 session；只有它能复位 lipSyncStore。 */
let activeSession: Session | null = null;
let audioCtx: AudioContext | null = null;
let stopperRegistered = false;

function newSession(): Session {
  return { audio: null, url: null, graph: null, raf: 0 };
}

function ensureStopper(): void {
  if (stopperRegistered) return;
  stopperRegistered = true;
  registerSpeechStopper(() => stopFishSpeak());
}

/** 幂等：只释放传入 session 自己持有的资源。 */
function releaseSession(session: Session): void {
  if (session.raf) {
    cancelAnimationFrame(session.raf);
    session.raf = 0;
  }
  if (session.graph) {
    const { source, analyser } = session.graph;
    session.graph = null;
    try {
      analyser.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
  }
  if (session.audio) {
    const audio = session.audio;
    session.audio = null;
    try {
      audio.pause();
      audio.src = '';
    } catch {
      /* ignore */
    }
  }
  if (session.url) {
    const url = session.url;
    session.url = null;
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
  if (activeSession === session) {
    activeSession = null;
    lipSyncStore.reset();
  }
}

/** 释放当前播放中的 session（切句 / 打断）。 */
function cleanupActive(): void {
  if (activeSession) releaseSession(activeSession);
  else lipSyncStore.reset();
}

/** Stop Fish playback (barge-in). */
export function stopFishSpeak(): void {
  generation++;
  cleanupActive();
}

/**
 * Optional lip-sync analyser. Must NOT call createMediaElementSource unless the
 * AudioContext is running: that API disconnects the element from the speakers,
 * and a suspended context produces complete silence (common Electron race when
 * resume() is fire-and-forget).
 * resume() 等待期间若这句已被取消（gen 变了），不再挂接包络。
 */
async function attachVolumeEnvelope(
  audio: HTMLAudioElement,
  session: Session,
  gen: number,
): Promise<void> {
  try {
    if (!audioCtx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new AC();
    }
    const ctx = audioCtx;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (gen !== generation) return; // cancelled while resuming
    if (ctx.state !== 'running') {
      // Leave the <audio> on its default output path so playback is still audible.
      return;
    }
    let wired = false;
    try {
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      session.graph = { source, analyser };
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      wired = true;
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (gen !== generation) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        lipSyncStore.set(Math.min(1, rms * 3));
        session.raf = requestAnimationFrame(tick);
      };
      session.raf = requestAnimationFrame(tick);
    } catch {
      // 还没连上 destination 的节点会留在 AudioContext 上。已经连上的图要留着，否则这句没有出声路径。
      if (!wired && session.graph) {
        const g = session.graph;
        session.graph = null;
        try {
          g.analyser.disconnect();
        } catch {
          /* ignore */
        }
        try {
          g.source.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* Autoplay / CORS / already connected — lip sync optional; element keeps default output if we never connected */
  }
}

/**
 * Try Fish synthesize + play. Returns true if Fish audio started (or completed setup).
 * Returns false when no TTS audio was produced.
 */
export async function speakWithFish(text: string, opts: FishSpeakOptions = {}): Promise<boolean> {
  ensureStopper();
  const trimmed = text.trim();
  if (!trimmed) {
    opts.onEnd?.();
    return false;
  }

  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.ttsSpeak) {
    opts.onEnd?.();
    return false;
  }

  const gen = ++generation;
  stopSoftSpeech();
  cleanupActive();
  const session = newSession();

  try {
    const result = await api.ttsSpeak({
      text: trimmed,
      referenceId: opts.referenceId,
      volume: opts.volume,
      speed: opts.speed,
    });
    if (gen !== generation) return true; // cancelled
    if (!result?.success || !result.audioBase64) {
      opts.onEnd?.();
      return false;
    }

    const mime = result.mimeType || 'audio/mpeg';
    const binary = atob(result.audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    session.url = url;

    const audio = new Audio();
    session.audio = audio;
    activeSession = session;
    audio.src = url;
    audio.volume = Math.max(0, Math.min(1, opts.volume ?? 0.78));
    audio.onended = () => {
      if (gen !== generation) return;
      releaseSession(session);
      opts.onEnd?.();
    };
    audio.onerror = () => {
      if (gen !== generation) return;
      releaseSession(session);
      opts.onEnd?.();
    };

    await attachVolumeEnvelope(audio, session, gen);
    if (gen !== generation) {
      releaseSession(session); // 已被取消：不再 play，只释放自己的资源
      return true;
    }
    await audio.play();
    return true;
  } catch (err) {
    log.warn('TTS playback failed; staying silent', err);
    // 只释放本句自己的资源；新句已经接管时 activeSession 不是我，不会被牵连
    releaseSession(session);
    if (gen === generation) opts.onEnd?.();
    return false;
  }
}

/** Map character voiceHint / fishReferenceId → built-in Fish reference preset. */
export function resolveFishReferenceId(
  voiceHint?: string,
  fishReferenceId?: string,
  fallback = 'nomi',
): string {
  if (fishReferenceId && fishReferenceId.trim()) return fishReferenceId.trim();
  if (voiceHint && /^[a-zA-Z0-9\-_ ]+$/.test(voiceHint.trim())) return voiceHint.trim();
  return fallback;
}
