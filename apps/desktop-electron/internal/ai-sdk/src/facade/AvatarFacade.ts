/**
 * AvatarFacade —— 角色操作薄封装。只有语义事件（docs/design/core-host-decoupling.md §10.5）：
 * AI → 角色 `emotion / gesture / activity / speaking`，角色 → AI `report` 与 `on('touched' | 'clicked' | 'scene')`。
 * 名字来自 `@nomi-ai/character-contract` 的词表，具体资源由角色包的 mapping.json 决定。
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
  type AvatarHost,
  type AvatarReport,
  type AvatarService,
} from '@nomi-ai/bundle-ig-mascot/seams';

import type { SdkContext } from '../di/SdkContext';
import { AIClientError, ErrorCodes } from '../errors';

export interface AvatarFacade {
  isAvailable(): boolean;
  emotion(name: Parameters<AvatarHost['emotion']>[0], weight?: number): Promise<void>;
  gesture(name: Parameters<AvatarHost['gesture']>[0]): Promise<void>;
  activity(name: Parameters<AvatarHost['activity']>[0]): Promise<void>;
  speaking(level: number): void;
  /** 角色窗口报告被摸 / 被点 / 场景 */
  report(event: AvatarReport): void;
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
    emotion: async (n, w) => require().emotion(n, w),
    gesture: async (n) => require().gesture(n),
    activity: async (n) => require().activity(n),
    speaking: (level) => require().speaking(level),
    report: (e) => require().report(e),
    on: (evt, fn) => require().on(evt, fn),
  };
}
