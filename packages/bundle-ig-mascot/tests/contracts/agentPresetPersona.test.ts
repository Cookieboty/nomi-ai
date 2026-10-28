import { describe, expect, it } from 'vitest';

import { buildWaifuSystemPrompt, WaifuAgentPresetPlugin } from '../../src/plugins';
import { AgentPresetRegistryKey, PersonaIdentityKey } from '../../src/seams/agentPreset';
import { createFakeCtx } from '../helpers/fakeCtx';

describe('WaifuAgentPresetPlugin · persona identity (docs/design/core-host-decoupling.md §10.4)', () => {
  it('buildWaifuSystemPrompt puts the injected identity right after the prefix', () => {
    const prompt = buildWaifuSystemPrompt(undefined, {
      prefix: '（前缀）',
      identity: '  You are Pip, a paper robot.  ',
      toolNames: [],
    });
    const lines = prompt.split('\n');
    expect(lines[0]).toBe('（前缀）');
    expect(lines[1]).toBe('You are Pip, a paper robot.');
  });

  it('uses the active pack persona from PersonaIdentityKey, read on every systemPrompt() call', async () => {
    const ctx = createFakeCtx();
    let identity = 'You are Pip, a paper robot.';
    ctx.provide(PersonaIdentityKey, { systemPromptIdentity: () => identity });
    await WaifuAgentPresetPlugin.apply(ctx, { identity: 'config identity' });
    const preset = ctx.inject(AgentPresetRegistryKey)!.get('waifu')!;

    const first = await preset.systemPrompt();
    expect(first).toContain('You are Pip, a paper robot.');
    expect(first).not.toContain('config identity');
    expect(first).not.toMatch(/Nomi|诺米/);

    identity = 'You are Moss.';
    expect(await preset.systemPrompt()).toContain('You are Moss.');
    expect(ctx.logs.some((l) => l.level === 'warn')).toBe(false);
  });

  it('falls back to config.identity when the seam yields nothing', async () => {
    const ctx = createFakeCtx();
    ctx.provide(PersonaIdentityKey, { systemPromptIdentity: () => undefined });
    await WaifuAgentPresetPlugin.apply(ctx, { identity: 'You are Pip.' });
    const preset = ctx.inject(AgentPresetRegistryKey)!.get('waifu')!;
    expect(await preset.systemPrompt()).toContain('You are Pip.');
  });

  it('never invents a character when no identity is injected', async () => {
    const ctx = createFakeCtx();
    await WaifuAgentPresetPlugin.apply(ctx, {});
    const preset = ctx.inject(AgentPresetRegistryKey)!.get('waifu')!;
    expect(await preset.systemPrompt()).not.toMatch(/Nomi|诺米/);
    expect(ctx.logs.some((l) => l.level === 'warn' && l.msg.includes('no persona identity'))).toBe(
      true,
    );
  });

  it('plugins entry re-exports the same PersonaIdentityKey instance', async () => {
    const plugins = await import('../../src/plugins');
    expect(plugins.PersonaIdentityKey).toBe(PersonaIdentityKey);
  });
});
