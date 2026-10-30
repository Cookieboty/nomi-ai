/**
 * AsrFacade —— 语音识别薄封装。
 *
 * 通过 [`AsrKey`](file:///../../bundle-ig-electron-caps/src/seams/asr.ts) 取得 插件宿主 注入的
 * `AsrService`；未注入时抛 `SEAM_NOT_INJECTED`（例如渲染进程 profile 未挂 electron-caps）。
 *
 * 依赖仅停留在**类型**层：`AsrKey` 通过子入口 `@nomi-ai/bundle-ig-electron-caps/seams`
 * 引入，避开 electron-caps 主入口的 `assertElectronMainProcess` 运行时守卫，保证 SDK
 * 在渲染 / CLI / 测试环境中也能纯类型编译。
 */

import {
  AsrKey,
  type AsrOptions,
  type AsrProviderInfo,
  type AsrResult,
  type AsrStreamEvent,
  type PcmChunk,
  type AsrService,
  type AsrProvider,
} from '@nomi-ai/bundle-ig-electron-caps/seams';

import type { SdkContext } from '../di/SdkContext';
import { AIClientError, ErrorCodes } from '../errors';

export interface AsrFacade {
  list(): AsrProviderInfo[];
  transcribe(pcm: PcmChunk, opts?: AsrOptions): Promise<AsrResult>;
  stream(pcmStream: AsyncIterable<PcmChunk>, opts?: AsrOptions): AsyncIterable<AsrStreamEvent>;
  register(provider: AsrProvider): void;
}

export function createAsrFacade(ctx: SdkContext): AsrFacade {
  const require = (): AsrService => {
    const svc = ctx.inject(AsrKey);
    if (!svc) {
      throw new AIClientError(
        ErrorCodes.SEAM_NOT_INJECTED,
        'ctx.asr 未注入；请确认 profile 已加载 bundle-ig-electron-caps',
      );
    }
    return svc;
  };
  return {
    list: () => require().list(),
    transcribe: (pcm, opts) => require().transcribe(pcm, opts),
    stream: (s, opts) => require().stream(s, opts),
    register: (p) => require().register(p),
  };
}
