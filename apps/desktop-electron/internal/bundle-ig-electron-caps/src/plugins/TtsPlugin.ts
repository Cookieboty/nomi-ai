import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';

import {
  TtsKey,
  type TtsChunk,
  type TtsOptions,
  type TtsProvider,
  type TtsProviderInfo,
  type TtsResult,
  type TtsService,
  type TtsVoice,
} from '../seams/tts';

import { AzureTtsProvider, EdgeTtsProvider, OpenAiTtsProvider } from './tts';

export interface TtsPluginConfig {
  defaultProviderId?: string;
  registerDefaults?: boolean;
}

class TtsServiceImpl implements TtsService {
  private readonly providers = new Map<string, TtsProvider>();
  private defaultId: string | undefined;

  constructor(defaultId: string | undefined) {
    this.defaultId = defaultId;
  }

  register(provider: TtsProvider): void {
    this.providers.set(provider.info.id, provider);
    if (!this.defaultId) this.defaultId = provider.info.id;
  }

  list(): TtsProviderInfo[] {
    return [...this.providers.values()].map((p) => p.info);
  }

  get(id: string): TtsProvider | undefined {
    return this.providers.get(id);
  }

  private pick(opts?: TtsOptions): TtsProvider {
    const id = opts?.providerId ?? this.defaultId;
    if (!id) throw new Error('[TtsService] no provider registered');
    const p = this.providers.get(id);
    if (!p) throw new Error(`[TtsService] provider not found: ${id}`);
    return p;
  }

  async synth(text: string, opts?: TtsOptions): Promise<TtsResult> {
    return this.pick(opts).synth(text, opts);
  }

  stream(text: string, opts?: TtsOptions): AsyncIterable<TtsChunk> {
    return this.pick(opts).stream(text, opts);
  }

  stop(reqId: string): void {
    for (const p of this.providers.values()) p.stop(reqId);
  }

  async listVoices(): Promise<TtsVoice[]> {
    const all: TtsVoice[] = [];
    for (const p of this.providers.values()) {
      try {
        const list = await p.listVoices();
        all.push(...list);
      } catch {
        /* skip providers that fail */
      }
    }
    return all;
  }
}

export const TtsPlugin = definePlugin<TtsPluginConfig>({
  name: 'TtsPlugin',
  apply(ctx: PluginContext, cfg: TtsPluginConfig) {
    const svc = new TtsServiceImpl(cfg.defaultProviderId);
    if (cfg.registerDefaults ?? true) {
      svc.register(new EdgeTtsProvider());
      svc.register(new OpenAiTtsProvider());
      svc.register(new AzureTtsProvider());
    }
    ctx.provide(TtsKey, svc);
    ctx.logger.info(`TtsPlugin ready: providers=${svc.list().length}`);
  },
});
