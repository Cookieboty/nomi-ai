import type { IProfileStorage } from '../../seams/userProfile';
import type { UserProfile } from '../../types/UserProfile';

/** 默认内存实现 —— P3 用文件版覆盖 */
export class InMemoryProfileStorage implements IProfileStorage {
  private data: UserProfile | undefined;

  async read(): Promise<UserProfile | undefined> {
    return this.data ? structuredClone(this.data) : undefined;
  }
  async write(profile: UserProfile): Promise<void> {
    this.data = structuredClone(profile);
  }
  async clear(): Promise<void> {
    this.data = undefined;
  }
}
