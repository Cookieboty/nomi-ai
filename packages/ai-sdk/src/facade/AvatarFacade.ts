/**
 * AvatarFacade —— 看板娘（角色形象）操作薄封装。
 *
 * 仅在注入了 `AvatarKey`（装载 AvatarSeamPlugin）的 profile 可用；否则抛 `SEAM_NOT_INJECTED`。
 *
 * 依赖只留在类型层：通过 [@nomi-ai/bundle-ig-mascot/seams](file:///../../bundle-ig-mascot/src/seams/index.ts)
 * 子入口引 `AvatarKey`，避免走 bundle 主入口触发 `assertRendererProcess`。
 */

import {
  AvatarKey,
  type AvatarEvent,
  type AvatarEventPayload,
  type AvatarService,
} from '@nomi-ai/bundle-ig-mascot/seams';

import type { SdkContext } from '../di/SdkContext';
import { AIClientError, ErrorCodes } from '../errors';

export interface AvatarFacade {
  isAvailable(): boolean;
  playMotion(group: string, index?: number): Promise<void>;
  setExpression(name: string): Promise<void>;
  driveLipSync(rms: number): void;
  on<E extends AvatarEvent>(evt: E, fn: (p: AvatarEventPayload<E>) => void): () => void;
}

export function createAvatarFacade(ctx: SdkContext): AvatarFacade {
  const tryGet = (): AvatarService | undefined => ctx.inject(AvatarKey);
  const require = (): AvatarService => {
    const svc = tryGet();
    if (!svc) {
      throw new AIClientError(
        ErrorCodes.SEAM_NOT_INJECTED,
        '角色形象仅在装载 bundle-ig-mascot 的 AvatarSeamPlugin 后可用',
      );
    }
    return svc;
  };
  return {
    isAvailable: () => Boolean(tryGet()),
    playMotion: async (g, i) => require().playMotion(g, i),
    setExpression: async (n) => require().setExpression(n),
    driveLipSync: (rms) => require().driveLipSync(rms),
    on: (evt, fn) => require().on(evt, fn),
  };
}
