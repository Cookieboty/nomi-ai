/**
 * Optional (advanced) Fish TTS orchestration for the main process.
 * No longer the product default (sherpa-onnx offline TTS is; see ../ttsRouter.ts).
 * When selected: fish-local + cute nomi seed (bundled sample.wav inlined as reference_audio).
 * On failure / disabled provider → silent result; renderer does not use Web Speech.
 * Does not expose user voice-upload cloning.
 */

import type { TTSConfig, TTSSpeakRequest, TTSSpeakResult, TTSTestResult } from '@nomi-ai/types';
import { app } from 'electron';

import { createMainLogger } from '../../utils/log';

import { builtinAssetsRoots, loadBuiltinReference } from './builtinReference';
import { FishTtsClient, resolveFishBaseUrl } from './FishTtsClient';
import { FishTtsConfigStore } from './FishTtsConfigStore';

const log = createMainLogger('FishTTS');

const HEALTH_CACHE_MS = 45_000;
const HEALTH_PROBE_MS = 800;

export class FishTtsService {
  private readonly store = new FishTtsConfigStore();
  private healthCache: { at: number; ok: boolean } | null = null;

  getConfig(): TTSConfig {
    return this.store.loadPublic();
  }

  saveConfig(cfg: TTSConfig): TTSConfig {
    this.healthCache = null;
    return this.store.save(cfg);
  }

  resetConfig(): void {
    this.healthCache = null;
    this.store.reset();
  }

  /**
   * Synthesize via Fish when enabled and provider is fish-*.
   * Never throws to IPC callers for "not configured" — returns a silent result.
   */
  async speak(req: TTSSpeakRequest): Promise<TTSSpeakResult> {
    const text = req.text?.trim();
    if (!text) {
      return { success: false, via: 'none', fallbackToSystem: false, message: 'empty text' };
    }

    const cfg = this.store.load();
    if (!cfg.enabled) {
      return { success: false, via: 'none', fallbackToSystem: false, message: 'tts disabled' };
    }

    if (cfg.provider === 'sherpa-theresa') {
      return { success: false, via: 'none', fallbackToSystem: false, message: 'handled by sherpa' };
    }

    if (cfg.provider === 'legacy') {
      return {
        success: false,
        via: 'legacy',
        fallbackToSystem: false,
        message: 'use legacy player',
      };
    }

    if (cfg.provider !== 'fish-local' && cfg.provider !== 'fish-cloud') {
      return { success: false, via: 'none', fallbackToSystem: false, message: 'unknown provider' };
    }

    // Skip long synthesize when recent health failed (keeps barge-in snappy).
    if (!(await this.isLikelyReachable(cfg))) {
      return {
        success: false,
        via: 'none',
        fallbackToSystem: false,
        message: 'Fish TTS unreachable',
      };
    }

    const referenceId = (req.referenceId || cfg.referenceId || 'nomi').trim() || 'nomi';
    const builtin = this.loadReference(referenceId);
    const client = this.createClient(cfg);

    try {
      const useInline = Boolean(builtin) && cfg.provider === 'fish-local';
      const result = await client.synthesize({
        text,
        // Local: embed bundled wav so fish-speech needs no references/nomi copy.
        // Cloud: reference_id only (inline audio needs msgpack on Fish cloud).
        referenceId: useInline ? undefined : referenceId,
        referenceAudioBase64: useInline ? builtin!.audioBase64 : undefined,
        referenceText: useInline ? builtin!.referenceText : undefined,
        format: cfg.format,
        cloudModel: cfg.cloudModel,
        timeoutMs: cfg.timeoutMs,
      });
      this.healthCache = { at: Date.now(), ok: true };
      return {
        success: true,
        via: 'fish',
        audioBase64: result.audio.toString('base64'),
        mimeType: result.mimeType,
        fallbackToSystem: false,
      };
    } catch (err) {
      this.healthCache = { at: Date.now(), ok: false };
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Fish synthesize failed; staying silent', { message });
      return {
        success: false,
        via: 'none',
        fallbackToSystem: false,
        message,
      };
    }
  }

  async checkHealth(override?: Partial<TTSConfig>): Promise<TTSTestResult> {
    const cfg = { ...this.store.load(), ...override };
    if (cfg.provider !== 'fish-local' && cfg.provider !== 'fish-cloud') {
      return { success: false, message: 'Health check is for fish-local / fish-cloud only' };
    }
    const started = Date.now();
    const client = this.createClient(cfg as TTSConfig, override?.apiKey);
    const health = await client.health(Math.min(cfg.timeoutMs || 5000, 5000));
    this.healthCache = { at: Date.now(), ok: health.ok };
    const builtin = this.loadReference(cfg.referenceId || 'nomi');
    const seedNote = builtin
      ? `; built-in seed ${builtin.id} ready (${Math.round(builtin.audioBase64.length / 1024)}KB b64)`
      : '; built-in seed missing';
    return {
      success: health.ok,
      message: health.message + seedNote,
      latency: health.latencyMs || Date.now() - started,
    };
  }

  private loadReference(referenceId: string) {
    let appPath: string | undefined;
    let resourcesPath: string | undefined;
    try {
      appPath = app.getAppPath();
    } catch {
      /* unit / non-electron */
    }
    if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
      resourcesPath = process.resourcesPath;
    }
    const roots = builtinAssetsRoots({ appPath, resourcesPath });
    return loadBuiltinReference(referenceId, { roots });
  }

  private createClient(cfg: TTSConfig, apiKeyOverride?: string): FishTtsClient {
    const mode = cfg.provider === 'fish-cloud' ? 'cloud' : 'local';
    const baseUrl = resolveFishBaseUrl(
      cfg.provider === 'fish-cloud' ? 'fish-cloud' : 'fish-local',
      cfg.baseUrl,
    );
    const apiKey =
      mode === 'cloud' ? apiKeyOverride?.trim() || this.store.getApiKey() || cfg.apiKey : undefined;
    return new FishTtsClient({ mode, baseUrl, apiKey });
  }

  private async isLikelyReachable(cfg: TTSConfig): Promise<boolean> {
    const now = Date.now();
    if (this.healthCache && now - this.healthCache.at < HEALTH_CACHE_MS) {
      return this.healthCache.ok;
    }
    if (cfg.provider === 'fish-cloud' && !this.store.getApiKey() && !cfg.apiKey) {
      this.healthCache = { at: now, ok: false };
      return false;
    }
    try {
      const client = this.createClient(cfg);
      const health = await client.health(HEALTH_PROBE_MS);
      this.healthCache = { at: Date.now(), ok: health.ok };
      return health.ok;
    } catch {
      this.healthCache = { at: Date.now(), ok: false };
      return false;
    }
  }
}

let singleton: FishTtsService | null = null;

export function getFishTtsService(): FishTtsService {
  if (!singleton) singleton = new FishTtsService();
  return singleton;
}
