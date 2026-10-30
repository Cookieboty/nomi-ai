import type {
  DeepPartial,
  IProfileStorage,
  ProfilePatch,
  UserProfileEvent,
  UserProfileService,
} from '../../seams/userProfile';
import { makeDefaultUserProfile, type UserProfile } from '../../types/UserProfile';
import { userProfileSchema } from '../../types/UserProfileSchema';

import { deepMerge } from './deepMerge';

export class ProfileStore implements UserProfileService {
  private profile: UserProfile = makeDefaultUserProfile();
  private loaded = false;
  private readonly listeners = new Map<UserProfileEvent, Set<(p: UserProfile) => void>>();

  constructor(private readonly storage: IProfileStorage) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const persisted = await this.storage.read();
    if (persisted) this.profile = persisted;
    this.loaded = true;
  }

  get(): UserProfile {
    return structuredClone(this.profile);
  }

  getPath<T = unknown>(path: string): T | undefined {
    const parts = path.split('.');
    let cur: unknown = this.profile;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur as T | undefined;
  }

  async set(patch: ProfilePatch): Promise<UserProfile> {
    await this.ensureLoaded();
    const next = deepMerge(structuredClone(this.profile), patch.patch as DeepPartial<UserProfile>);
    next.updatedAt = Date.now();
    // 严校验：写入前必须通过 zod
    const validated = userProfileSchema.parse(next);
    this.profile = validated as UserProfile;
    await this.storage.write(this.profile);
    this.fire('changed');
    return this.get();
  }

  async reset(): Promise<UserProfile> {
    this.profile = makeDefaultUserProfile();
    await this.storage.write(this.profile);
    this.loaded = true;
    this.fire('changed');
    return this.get();
  }

  subscribe(evt: UserProfileEvent, fn: (p: UserProfile) => void): () => void {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(fn);
    return () => this.listeners.get(evt)?.delete(fn);
  }

  async export(): Promise<UserProfile> {
    await this.ensureLoaded();
    return this.get();
  }

  async import(data: unknown): Promise<UserProfile> {
    const validated = userProfileSchema.parse(data);
    this.profile = validated as UserProfile;
    await this.storage.write(this.profile);
    this.loaded = true;
    this.fire('changed');
    return this.get();
  }

  private fire(evt: UserProfileEvent): void {
    const snap = this.get();
    this.listeners.get(evt)?.forEach((fn) => {
      try {
        fn(snap);
      } catch {
        /* ignore */
      }
    });
  }
}
