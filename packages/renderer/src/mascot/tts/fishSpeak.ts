/**
 * TTS playback in the renderer (sherpa / Fish / any engine returning audio via IPC).
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

let generation = 0;
let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let analyserRaf = 0;
let audioCtx: AudioContext | null = null;
let stopperRegistered = false;
/** 连在常驻 AudioContext 上的节点。不 disconnect 的话，每句 TTS 都会留下一条音频图。 */
let graph: { source: AudioNode; analyser: AudioNode } | null = null;

function ensureStopper(): void {
  if (stopperRegistered) return;
  stopperRegistered = true;
  registerSpeechStopper(() => stopFishSpeak());
}

function stopAnalyser(): void {
  if (analyserRaf) {
    cancelAnimationFrame(analyserRaf);
    analyserRaf = 0;
  }
  lipSyncStore.reset();
}

function disconnectGraph(): void {
  if (!graph) return;
  try {
    graph.analyser.disconnect();
  } catch {
    /* already disconnected */
  }
  try {
    graph.source.disconnect();
  } catch {
    /* already disconnected */
  }
  graph = null;
}

function cleanupAudio(): void {
  stopAnalyser();
  disconnectGraph();
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.src = '';
    } catch {
      /* ignore */
    }
    currentAudio = null;
  }
  if (currentUrl) {
    try {
      URL.revokeObjectURL(currentUrl);
    } catch {
      /* ignore */
    }
    currentUrl = null;
  }
}

/** Stop Fish playback (barge-in). */
export function stopFishSpeak(): void {
  generation++;
  cleanupAudio();
}

/**
 * Optional lip-sync analyser. Must NOT call createMediaElementSource unless the
 * AudioContext is running: that API disconnects the element from the speakers,
 * and a suspended context produces complete silence (common Electron race when
 * resume() is fire-and-forget).
 */
async function attachVolumeEnvelope(audio: HTMLAudioElement): Promise<void> {
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
    if (ctx.state !== 'running') {
      // Leave the <audio> on its default output path so playback is still audible.
      return;
    }
    let wired = false;
    try {
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      graph = { source, analyser };
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      wired = true;
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        lipSyncStore.set(Math.min(1, rms * 3));
        analyserRaf = requestAnimationFrame(tick);
      };
      analyserRaf = requestAnimationFrame(tick);
    } catch {
      // 还没连上 destination 的节点会留在 AudioContext 上。已经连上的图要留着，否则这句没有出声路径。
      if (!wired) disconnectGraph();
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
  cleanupAudio();

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
    currentUrl = url;

    const audio = new Audio();
    currentAudio = audio;
    audio.src = url;
    audio.volume = Math.max(0, Math.min(1, opts.volume ?? 0.78));
    audio.onended = () => {
      if (gen !== generation) return;
      cleanupAudio();
      opts.onEnd?.();
    };
    audio.onerror = () => {
      if (gen !== generation) return;
      cleanupAudio();
      opts.onEnd?.();
    };

    await attachVolumeEnvelope(audio);
    await audio.play();
    return true;
  } catch (err) {
    log.warn('TTS playback failed; staying silent', err);
    cleanupAudio();
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
