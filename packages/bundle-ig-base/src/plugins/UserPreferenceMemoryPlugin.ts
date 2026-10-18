import { ToolRegistryKey } from '../seams/tools';
import { ProfileStorageKey, UserProfileKey, type IProfileStorage } from '../seams/userProfile';
import { definePlugin, type PluginContext } from '../types/plugin';

import {
  HabitStatCollector,
  InMemoryProfileStorage,
  PreferenceExtractor,
  ProfileStore,
  createPreferenceTools,
} from './userProfile';

export interface UserPreferenceMemoryConfig {
  /** 允许 LLM 直接调用 set/get/list/forget 偏好工具 */
  exposeAsTools?: boolean;
}

interface UserMessagePayload {
  content: string;
  at?: number;
}

interface ToolPostExecutePayload {
  tool: string;
  ok: boolean;
}

export const UserPreferenceMemoryPlugin = definePlugin<UserPreferenceMemoryConfig>({
  name: 'UserPreferenceMemoryPlugin',
  apply(ctx: PluginContext, cfg: UserPreferenceMemoryConfig) {
    const storage: IProfileStorage = ctx.inject(ProfileStorageKey) ?? new InMemoryProfileStorage();
    const store = new ProfileStore(storage);
    ctx.provide(UserProfileKey, store);

    const extractor = new PreferenceExtractor();
    const habits = new HabitStatCollector();

    // 1) 从每条用户消息里做规则抽取
    ctx.on<UserMessagePayload>('session/user-message', async (hookCtx) => {
      const { content, at } = hookCtx.payload;
      habits.onUserMessage(at ?? Date.now());
      const patches = extractor.extract(content);
      for (const patch of patches) {
        try {
          await store.set(patch);
        } catch (err) {
          ctx.logger.warn('extractor patch rejected by schema', err);
        }
      }
    });

    // 2) 工具执行计数（用于 habits.topTools）
    ctx.on<ToolPostExecutePayload>('tools/post-execute', (hookCtx) => {
      if (hookCtx.payload.ok) habits.onToolCall(hookCtx.payload.tool);
    });

    ctx.on('agent/stopped-by-user', () => habits.onStopGeneration());
    ctx.on('agent/regenerate', () => habits.onRegenerate());

    // 3) 变更广播
    store.subscribe('changed', (p) => ctx.emit('userProfile/changed', p));

    // 4) 暴露偏好工具（可关闭）
    if (cfg.exposeAsTools ?? true) {
      const reg = ctx.inject(ToolRegistryKey);
      if (reg) {
        for (const t of createPreferenceTools(store)) reg.register(t);
      } else {
        ctx.logger.warn('ToolRegistry not available; preference tools skipped');
      }
    }

    ctx.logger.info('user preference memory installed');
  },
});
