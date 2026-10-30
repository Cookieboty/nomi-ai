/**
 * TtsFacade —— 语音合成薄封装（含 stream / stop / listVoices）。
 *
 * 通过子入口 `@nomi-ai/bundle-ig-electron-caps/seams` 引 `TtsKey` 与类型，避开主入口的
 * `assertElectronMainProcess` 运行时守卫。
 */

import {
  TtsKey,
  type TtsChunk,
  type TtsOptions,
  type TtsProvider,
  type TtsProviderInfo,
  type TtsResult,
  type TtsService,
  type TtsVoice,
} from '@nomi-ai/bundle-ig-electron-caps/seams';

import type { SdkContext } from '../di/SdkContext';
import { AIClientError, ErrorCodes } from '../errors';

export interface TtsFacade {
  list(): TtsProviderInfo[];
  listVoices(): Promise<TtsVoice[]>;
  synth(text: string, opts?: TtsOptions): Promise<TtsResult>;
  stream(text: string, opts?: TtsOptions): AsyncIterable<TtsChunk>;
  stop(reqId: string): void;
  register(provider: TtsProvider): void;
}

export function createTtsFacade(ctx: SdkContext): TtsFacade {
  const require = (): TtsService => {
    const svc = ctx.inject(TtsKey);
    if (!svc) {
      throw new AIClientError(
        ErrorCodes.SEAM_NOT_INJECTED,
        'ctx.tts 未注入；请确认 profile 已加载 bundle-ig-electron-caps',
      );
    }
    return svc;
  };
  return {
    list: () => require().list(),
    listVoices: () => require().listVoices(),
    synth: (t, o) => require().synth(t, o),
    stream: (t, o) => require().stream(t, o),
    stop: (id) => require().stop(id),
    register: (p) => require().register(p),
  };
}
