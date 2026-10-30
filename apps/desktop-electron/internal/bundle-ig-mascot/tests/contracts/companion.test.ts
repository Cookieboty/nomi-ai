import {
  ToolRegistryKey,
  UserProfileKey,
  type ToolDefinition,
  type ToolRegistry,
  type UserProfile,
  type UserProfileService,
} from '@nomi-ai/bundle-ig-base';
import { SEMANTIC_EMOTIONS, SEMANTIC_GESTURES } from '@nomi-ai/character-contract';
import { describe, expect, it } from 'vitest';

import { AvatarSeamPlugin } from '../../src/plugins/AvatarSeamPlugin';
import {
  buildCompanionSystemPrompt,
  COMPANION_PRESET,
  CompanionAgentPresetPlugin,
} from '../../src/plugins/CompanionAgentPresetPlugin';
import {
  CompanionToolsPlugin,
  createEmotionTool,
  createGestureTool,
  emotionInputSchema,
  gestureInputSchema,
} from '../../src/plugins/CompanionToolsPlugin';
import { AgentPresetRegistryKey } from '../../src/seams/agentPreset';
import { AvatarKey } from '../../src/seams/avatar';
import { createFakeAvatarHost } from '../helpers/fakeAvatarHost';
import { createFakeCtx } from '../helpers/fakeCtx';

function createFakeRegistry(): ToolRegistry {
  const map = new Map<string, ToolDefinition>();
  return {
    register(tool) {
      map.set(tool.name, tool as ToolDefinition);
    },
    get(name) {
      return map.get(name);
    },
    list() {
      return [...map.values()];
    },
  };
}

function createFakeProfile(data: Partial<Record<string, unknown>>): UserProfileService {
  return {
    get(): UserProfile {
      return {} as UserProfile;
    },
    getPath<T = unknown>(path: string): T | undefined {
      return data[path] as T | undefined;
    },
    set: async () => ({}) as UserProfile,
    reset: async () => ({}) as UserProfile,
    subscribe: () => () => undefined,
    export: async () => ({}) as UserProfile,
    import: async () => ({}) as UserProfile,
  };
}

describe('CompanionToolsPlugin schema (semantic names only, §10.5)', () => {
  it('avatar_gesture accepts every semantic gesture and nothing else', () => {
    for (const name of SEMANTIC_GESTURES) {
      expect(gestureInputSchema.parse({ name })).toEqual({ name });
    }
    // 资源名 / 旧的动作参数过不了
    expect(() => gestureInputSchema.parse({ name: 'thumbs_up' })).toThrow();
    expect(() => gestureInputSchema.parse({ name: 'think-on' })).toThrow();
    expect(() => gestureInputSchema.parse({ group: 'wave' })).toThrow();
    expect(() => gestureInputSchema.parse({ name: 'wave', index: 0 })).toThrow();
  });

  it('avatar_emotion accepts every semantic emotion with an optional weight', () => {
    for (const name of SEMANTIC_EMOTIONS) {
      expect(emotionInputSchema.parse({ name })).toEqual({ name });
    }
    expect(emotionInputSchema.parse({ name: 'happy', weight: 0.5 })).toEqual({
      name: 'happy',
      weight: 0.5,
    });
    expect(() => emotionInputSchema.parse({ name: 'smile' })).toThrow();
    expect(() => emotionInputSchema.parse({ name: 'happy', weight: 2 })).toThrow();
  });

  it('tool descriptions name the semantic vocabulary and no character', () => {
    const avatar = {} as never;
    const gesture = createGestureTool(avatar, { dangerous: false });
    const emotion = createEmotionTool(avatar, { dangerous: false });
    for (const g of SEMANTIC_GESTURES) expect(gesture.description).toContain(g);
    for (const e of SEMANTIC_EMOTIONS) expect(emotion.description).toContain(e);
    for (const tool of [gesture, emotion]) {
      expect(tool.description).not.toMatch(/Nomi|诺米/);
      // 不出现任何资源名（下划线 / 连字符形状）
      expect(tool.description).not.toMatch(/[a-z]+[_-][a-z]+/);
    }
  });
});

describe('CompanionToolsPlugin', () => {
  async function setup(cfg: Parameters<typeof CompanionToolsPlugin.apply>[1] = {}) {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey)!;
    const host = createFakeAvatarHost();
    svc.attachHost(host);
    const registry = createFakeRegistry();
    ctx.provide(ToolRegistryKey, registry);
    await CompanionToolsPlugin.apply(ctx, cfg);
    return { ctx, host, registry };
  }

  it('registers avatar_gesture and avatar_emotion', async () => {
    const { registry } = await setup();
    expect(
      registry
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['avatar_emotion', 'avatar_gesture']);
  });

  it('autoConfirm=true marks tools as dangerous=false', async () => {
    const { registry } = await setup({ autoConfirm: true });
    for (const tool of registry.list()) {
      expect(tool.dangerous).toBe(false);
    }
  });

  it('autoConfirm=false marks tools as dangerous=true', async () => {
    const { registry } = await setup({ autoConfirm: false });
    for (const tool of registry.list()) {
      expect(tool.dangerous).toBe(true);
    }
  });

  it('tool execute drives AvatarService and returns ok', async () => {
    const { registry, host } = await setup();
    const play = registry.get('avatar_gesture')!;
    const expr = registry.get('avatar_emotion')!;
    await expect(play.execute({ name: 'thumbsUp' }, {})).resolves.toEqual({ ok: true });
    await expect(expr.execute({ name: 'happy', weight: 0.4 }, {})).resolves.toEqual({ ok: true });
    expect(host.record.gesture).toEqual(['thumbsUp']);
    expect(host.record.emotion).toEqual([{ name: 'happy', weight: 0.4 }]);
    await expect(play.execute({ name: 'idle' } as never, {})).rejects.toThrow();
    expect(host.record.gesture).toEqual(['thumbsUp']);
  });

  it('warns and skips when tool registry not available', async () => {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    await CompanionToolsPlugin.apply(ctx, {});
    expect(
      ctx.logs.some((l) => l.level === 'warn' && l.msg.includes('ctx.tools not available')),
    ).toBe(true);
  });
});

describe('buildCompanionSystemPrompt', () => {
  it('picks cute tone by default when profile absent', () => {
    const prompt = buildCompanionSystemPrompt(undefined, { toolNames: [] });
    // 插件包不内置角色人设：没有注入身份时不出现任何角色名
    expect(prompt).not.toMatch(/Nomi|诺米/);
    expect(prompt).toContain('可爱');
  });

  it('uses tone value from profile.preferences.tone', () => {
    const profile = createFakeProfile({
      'preferences.tone': { value: 'strict' },
    });
    const prompt = buildCompanionSystemPrompt(profile, { toolNames: [] });
    expect(prompt).toContain('严谨');
  });

  it('includes nickname and tool listing', () => {
    const profile = createFakeProfile({
      'preferences.tone': { value: 'casual' },
      'identity.nickname': '小明',
    });
    const prompt = buildCompanionSystemPrompt(profile, {
      toolNames: ['avatar_gesture', 'echo'],
      prefix: '（内部前缀）',
    });
    expect(prompt.startsWith('（内部前缀）')).toBe(true);
    expect(prompt).toContain('小明');
    expect(prompt).toContain('avatar_gesture, echo');
    expect(prompt).toContain('轻松');
  });

  it('unknown tone falls back to cute line', () => {
    const profile = createFakeProfile({
      'preferences.tone': { value: 'martian' },
    });
    const prompt = buildCompanionSystemPrompt(profile, { toolNames: [] });
    expect(prompt).toContain('可爱');
  });
});

describe('CompanionAgentPresetPlugin', () => {
  async function setup(cfg: Parameters<typeof CompanionAgentPresetPlugin.apply>[1] = {}) {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey)!;
    svc.attachHost(createFakeAvatarHost());
    ctx.provide(ToolRegistryKey, createFakeRegistry());
    await CompanionToolsPlugin.apply(ctx, {});
    const profile = createFakeProfile({ 'preferences.tone': { value: 'cute' } });
    ctx.provide(UserProfileKey, profile);
    await CompanionAgentPresetPlugin.apply(ctx, cfg);
    return { ctx };
  }

  it('registers the companion preset with expected whitelist', async () => {
    const { ctx } = await setup();
    const registry = ctx.inject(AgentPresetRegistryKey);
    expect(registry).toBeDefined();
    expect(COMPANION_PRESET).toBe('companion');
    const preset = registry!.get('companion');
    expect(preset).toBeDefined();
    expect(preset!.toolWhitelist).toEqual([
      'avatar_gesture',
      'avatar_emotion',
      'time_now',
      'random',
      'echo',
    ]);
    expect(preset!.disable).toEqual(['mcp', 'http_get_readonly']);
  });

  it('systemPrompt is dynamic and reads current UserProfile', async () => {
    const { ctx } = await setup();
    const registry = ctx.inject(AgentPresetRegistryKey)!;
    const preset = registry.get('companion')!;
    const prompt = await preset.systemPrompt();
    expect(prompt).toContain('可爱');
    expect(prompt).toContain('avatar_gesture');
  });

  it('supports custom preset name / tools / disable via config', async () => {
    const { ctx } = await setup({
      presetName: 'companion-plus',
      builtinTools: ['time_now'],
      disable: ['mcp'],
    });
    const registry = ctx.inject(AgentPresetRegistryKey)!;
    const preset = registry.get('companion-plus');
    expect(preset).toBeDefined();
    expect(preset!.toolWhitelist).toEqual(['avatar_gesture', 'avatar_emotion', 'time_now']);
    expect(preset!.disable).toEqual(['mcp']);
    expect(registry.get('companion')).toBeUndefined();
  });
});
