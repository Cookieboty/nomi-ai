/**
 * 看板娘语音播放：预录提示语（playAudioClip）与实时朗读引擎返回的音频（speakRealtime）。
 * 驱动 lipSyncStore 口型、支持打断；失败返回 false，调用方保持静默。
 */

import { createLogger } from '@nomi-ai/ui';

import { lipSyncStore } from '../../ai/lipSyncStore';
import { stopSoftSpeech } from '../softSpeech';
import { registerSpeechStopper } from '../speechStop';

const log = createLogger('mascot-audio');

export interface SpeakOptions {
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
  registerSpeechStopper(() => stopSpeaking());
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

/** Stop playback (barge-in). */
export function stopSpeaking(): void {
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
 * 在给定 session 里播放一个音频地址：挂接口型包络（AnalyserNode RMS → lipSyncStore）后 play。
 * 预录提示语与实时 TTS 共用这条路径，因此共享打断 / 切句 / 口型复位逻辑。
 */
async function playInSession(
  src: string,
  session: Session,
  gen: number,
  opts: { volume?: number; onEnd?: () => void },
): Promise<void> {
  const audio = new Audio();
  session.audio = audio;
  activeSession = session;
  audio.src = src;
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
    return;
  }
  await audio.play();
}

/**
 * 播放一段静态音频（预录提示语）。与 speakRealtime 共用打断与口型同步。
 * 返回 true 表示已开始播放；play() 失败返回 false 且不调用 onEnd（调用方继续兜底）。
 */
export async function playAudioClip(
  src: string,
  opts: { volume?: number; onEnd?: () => void } = {},
): Promise<boolean> {
  ensureStopper();
  const gen = ++generation;
  stopSoftSpeech();
  cleanupActive();
  const session = newSession();
  try {
    await playInSession(src, session, gen, opts);
    return true;
  } catch (err) {
    log.warn('clip playback failed', err);
    releaseSession(session);
    return false;
  }
}

/**
 * 请主进程实时朗读引擎合成并播放。返回 true 表示已开始播放；没有音频时返回 false。
 */
export async function speakRealtime(text: string, opts: SpeakOptions = {}): Promise<boolean> {
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

    await playInSession(url, session, gen, opts);
    return true;
  } catch (err) {
    log.warn('TTS playback failed; staying silent', err);
    // 只释放本句自己的资源；新句已经接管时 activeSession 不是我，不会被牵连
    releaseSession(session);
    if (gen === generation) opts.onEnd?.();
    return false;
  }
}
