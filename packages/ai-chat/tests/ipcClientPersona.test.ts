// @vitest-environment happy-dom
import type { Persona } from '@nomi-ai/types';
import { t } from '@nomi-ai/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultSystemPrompt, SdkIPCClient } from '../src/services/IPCClient';

// 默认系统提示从当前角色人设取（docs/design/core-host-decoupling.md §10.4）
const GUIDANCE = 'ui.chat-settings.you-run-on-the-user-s-own-computer-be';
const LEGACY_KEY = 'ui.chat-settings.you-are-nomi-an-ai-companion-who-lives'; // i18n-ignore

const pip: Persona = {
  characterId: 'test-dummy',
  displayName: 'Pip',
  systemPromptIdentity: 'You are Pip, a paper robot.',
  greetings: [],
};

type Msg = { role: string; content: string };

function capture(profile: Record<string, unknown> = {}) {
  const calls: Array<{ messages: Msg[] }> = [];
  let stored = profile;
  const client = {
    chat: {
      async sendMessage(opts: { messages: Msg[] }) {
        calls.push(opts);
        return { content: 'ok' };
      },
      stream: vi.fn(),
      abort: vi.fn(),
    },
    memory: {
      userProfile: {
        get: () => stored,
        set: async ({ patch }: { patch: Record<string, unknown> }) => {
          stored = { ...stored, ...patch };
        },
      },
    },
    dispose: vi.fn(),
  };
  return { client, calls };
}
const systemOf = (c: { messages: Msg[] }) => c.messages.find((m) => m.role === 'system')?.content;

afterEach(() => {
  window.localStorage.clear();
});

describe('SdkIPCClient · default system prompt comes from the persona', () => {
  it('uses the active pack persona identity plus the character-neutral chat guidance', async () => {
    const { client, calls } = capture();
    const ipc = new SdkIPCClient(client as never, { persona: async () => pip });
    await ipc.sendMessage('hi');
    const sys = systemOf(calls[0]!)!;
    expect(sys.startsWith('You are Pip, a paper robot.')).toBe(true);
    expect(sys).toContain(t(GUIDANCE));
    expect(sys).not.toMatch(/Nomi|诺米/);
  });

  it('guidance text carries no character identity', () => {
    expect(t(GUIDANCE)).not.toMatch(/Nomi|诺米/);
    expect(t(GUIDANCE)).not.toBe(GUIDANCE);
    expect(defaultSystemPrompt(undefined)).toBe(t(GUIDANCE));
  });

  it('reads the persona on every turn (pack / UI language switches apply at once)', async () => {
    const { client, calls } = capture();
    let identity = 'You are Pip.';
    const ipc = new SdkIPCClient(client as never, {
      persona: async () => ({ ...pip, systemPromptIdentity: identity }),
    });
    await ipc.sendMessage('hi');
    identity = '你是小纸。';
    await ipc.sendMessage('hi', [], 'memory recall');
    expect(systemOf(calls[0]!)).toBe(`You are Pip.\n${t(GUIDANCE)}`);
    expect(systemOf(calls[1]!)).toBe(`你是小纸。\n${t(GUIDANCE)}\n\nmemory recall`);
  });

  it('treats the legacy stored i18n key as "not customised"', async () => {
    const { client, calls } = capture({ chat: { systemPrompt: LEGACY_KEY } });
    const ipc = new SdkIPCClient(client as never, { persona: async () => pip });
    expect((await ipc.getConfig()).systemPrompt).toBeUndefined();
    await ipc.sendMessage('hi');
    expect(systemOf(calls[0]!)).toContain('You are Pip, a paper robot.');
    expect(systemOf(calls[0]!)).not.toContain(LEGACY_KEY);
  });

  it('migrates the legacy key from local storage too, and does not persist it back', async () => {
    window.localStorage.setItem(
      'ai-chat:config',
      JSON.stringify({ theme: 'dark', systemPrompt: LEGACY_KEY }),
    );
    const { client } = capture();
    const ipc = new SdkIPCClient(client as never, { persona: async () => pip });
    await ipc.updateConfig({ fontSize: 16 });
    const saved = JSON.parse(window.localStorage.getItem('ai-chat:config')!);
    expect(saved.systemPrompt).toBeUndefined();
    expect(saved.theme).toBe('dark');
  });

  it('keeps a user-written prompt (and an explicitly cleared one) as is', async () => {
    const { client, calls } = capture();
    const persona = vi.fn(async () => pip);
    const ipc = new SdkIPCClient(client as never, { persona });
    await ipc.updateConfig({ systemPrompt: 'Custom prompt' });
    await ipc.sendMessage('hi');
    await ipc.updateConfig({ systemPrompt: '' });
    await ipc.sendMessage('hi');
    expect(systemOf(calls[0]!)).toBe('Custom prompt');
    expect(systemOf(calls[1]!)).toBeUndefined();
    expect(persona).not.toHaveBeenCalled();
  });

  it('reads the persona from the preload bridge by default', async () => {
    const get = vi.fn(async () => pip);
    (window as unknown as { electronAPI?: unknown }).electronAPI = { persona: { get } };
    try {
      const { client, calls } = capture();
      const ipc = new SdkIPCClient(client as never);
      await ipc.sendMessage('hi');
      expect(get).toHaveBeenCalled();
      expect(systemOf(calls[0]!)).toContain('You are Pip, a paper robot.');
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });
});
