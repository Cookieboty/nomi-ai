/**
 * MemoryFacade —— facts / summaries / userProfile 三大子域。
 *
 * P5 阶段：
 * - `facts` / `summaries` 使用**内存版占位存储**（真实存储在 P6/P8 挂到 插件宿主 存储层）；
 * - `userProfile` 直接代理 [`UserProfileService`](file:///../../bundle-ig-base/src/seams/userProfile.ts)，
 *   保持类型与 bundle-ig-base 完全一致（P5 计划 §P5-2 要求 re-export）。
 */

import {
  UserProfileKey,
  type ProfilePatch,
  type UserProfileService,
} from '@nomi-ai/bundle-ig-base';

import type { SdkContext } from '../di/SdkContext';
import { AIClientError, ErrorCodes } from '../errors';
import type { MemoryFact, SessionSummary } from '../types/MemoryFact';
import type { UserProfile } from '../types/UserProfile';

export interface UserProfileSubApi {
  get(): UserProfile;
  set(patch: ProfilePatch): Promise<UserProfile>;
  reset(): Promise<UserProfile>;
  subscribe(fn: (p: UserProfile) => void): () => void;
  export(): Promise<UserProfile>;
  import(data: unknown): Promise<UserProfile>;
}

export interface MemoryFacade {
  facts: {
    list(): MemoryFact[];
    put(fact: MemoryFact): MemoryFact;
    delete(id: string): boolean;
  };
  summaries: {
    get(sessionId: string): SessionSummary | undefined;
    put(summary: SessionSummary): SessionSummary;
  };
  userProfile: UserProfileSubApi;
}

export function createMemoryFacade(ctx: SdkContext): MemoryFacade {
  const facts = new Map<string, MemoryFact>();
  const summaries = new Map<string, SessionSummary>();

  const requireProfile = (): UserProfileService => {
    const svc = ctx.inject(UserProfileKey);
    if (!svc) {
      throw new AIClientError(
        ErrorCodes.SEAM_NOT_INJECTED,
        'ctx.userProfile 未注入；请确认已加载 bundle-ig-base',
      );
    }
    return svc;
  };

  return {
    facts: {
      list() {
        return [...facts.values()].map((f) => ({ ...f }));
      },
      put(fact) {
        facts.set(fact.id, { ...fact });
        return { ...fact };
      },
      delete(id) {
        return facts.delete(id);
      },
    },
    summaries: {
      get(sessionId) {
        const s = summaries.get(sessionId);
        return s ? { ...s } : undefined;
      },
      put(summary) {
        summaries.set(summary.sessionId, { ...summary });
        return { ...summary };
      },
    },
    userProfile: {
      get() {
        return requireProfile().get() as UserProfile;
      },
      async set(patch) {
        return (await requireProfile().set(patch)) as UserProfile;
      },
      async reset() {
        return (await requireProfile().reset()) as UserProfile;
      },
      subscribe(fn) {
        return requireProfile().subscribe('changed', (p) => fn(p as UserProfile));
      },
      async export() {
        return (await requireProfile().export()) as UserProfile;
      },
      async import(data) {
        return (await requireProfile().import(data)) as UserProfile;
      },
    },
  };
}
