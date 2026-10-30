import { defineService } from '../types/plugin';
import type { UserProfile } from '../types/UserProfile';

/** 深度可选 —— 供 set / patch 使用 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export type ProfilePatchSource = 'user' | 'inferred' | 'distilled';

export interface ProfilePatch {
  patch: DeepPartial<UserProfile>;
  source: ProfilePatchSource;
  reason?: string;
}

export type UserProfileEvent = 'changed';

export interface UserProfileService {
  /** 完整读取（拷贝，避免外部改动） */
  get(): UserProfile;
  /** 读取子路径（点路径，如 'preferences.replyStyle'） */
  getPath<T = unknown>(path: string): T | undefined;
  /** deep-merge patch，写入前跑 zod 校验，失败抛错 */
  set(patch: ProfilePatch): Promise<UserProfile>;
  /** 重置为默认 profile */
  reset(): Promise<UserProfile>;
  /** 变更订阅 */
  subscribe(evt: UserProfileEvent, fn: (p: UserProfile) => void): () => void;
  /** 导出（用于隐私一键导出） */
  export(): Promise<UserProfile>;
  /** 导入（用于同步或备份恢复） */
  import(data: unknown): Promise<UserProfile>;
}

/**
 * P3 会把默认的 InMemoryProfileStorage 覆盖为文件版；
 * 这里定义存储抽象，方便注入不同后端。
 */
export interface IProfileStorage {
  read(): Promise<UserProfile | undefined>;
  write(profile: UserProfile): Promise<void>;
  clear(): Promise<void>;
}

export const UserProfileKey = defineService<UserProfileService>('ctx.userProfile');
export const ProfileStorageKey = defineService<IProfileStorage>('ctx.userProfileStorage');
