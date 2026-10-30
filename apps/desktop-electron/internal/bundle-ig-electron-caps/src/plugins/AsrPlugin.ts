import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';

import {
  AsrKey,
  type AsrOptions,
  type AsrProvider,
  type AsrProviderInfo,
  type AsrResult,
  type AsrService,
  type AsrStreamEvent,
  type PcmChunk,
} from '../seams/asr';

import { OpenAIWhisperProvider, VolcAsrProvider, WhisperLocalProvider } from './asr';

export interface AsrPluginConfig {
  /** 默认 provider id */
  defaultProviderId?: string;
  /** 是否内置注册 3 家默认 provider，默认 true */
  registerDefaults?: boolean;
}

class AsrServiceImpl implements AsrService {
  private readonly providers = new Map<string, AsrProvider>();
  private defaultId: string | undefined;

  constructor(defaultId: string | undefined) {
    this.defaultId = defaultId;
  }

  register(provider: AsrProvider): void {
    this.providers.set(provider.info.id, provider);
    if (!this.defaultId) this.defaultId = provider.info.id;
  }

  list(): AsrProviderInfo[] {
    return [...this.providers.values()].map((p) => p.info);
  }

  get(id: string): AsrProvider | undefined {
    return this.providers.get(id);
  }

  private pick(opts?: AsrOptions): AsrProvider {
    const id = opts?.providerId ?? this.defaultId;
    if (!id) throw new Error('[AsrService] no provider registered');
    const p = this.providers.get(id);
    if (!p) throw new Error(`[AsrService] provider not found: ${id}`);
    return p;
  }

  async transcribe(pcm: PcmChunk, opts?: AsrOptions): Promise<AsrResult> {
    return this.pick(opts).transcribe(pcm, opts);
  }

  stream(pcmStream: AsyncIterable<PcmChunk>, opts?: AsrOptions): AsyncIterable<AsrStreamEvent> {
    return this.pick(opts).stream(pcmStream, opts);
  }
}

export const AsrPlugin = definePlugin<AsrPluginConfig>({
  name: 'AsrPlugin',
  apply(ctx: PluginContext, cfg: AsrPluginConfig) {
    const svc = new AsrServiceImpl(cfg.defaultProviderId);
    if (cfg.registerDefaults ?? true) {
      svc.register(new WhisperLocalProvider());
      svc.register(new OpenAIWhisperProvider());
      svc.register(new VolcAsrProvider());
    }
    ctx.provide(AsrKey, svc);
    ctx.logger.info(`AsrPlugin ready: providers=${svc.list().length}`);
  },
});
