// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SdkIPCClient } from '../src/services/IPCClient';

import { installMascotHost, resetMascotHost } from './helpers/mascotHost';

vi.mock('../src/services/api', async () =>
  (await import('./helpers/mascotHost')).mascotApiModule(),
);

// 默认系统提示由内核拼装（契约 persona.systemPrompt，docs/design/core-host-decoupling.md §10.4）；
// 拼装与官方文案的逐字固定见 core tests/unit/persona/systemPrompt.test.ts
const LEGACY_KEY = 'ui.chat-settings.you-are-nomi-an-ai-companion-who-lives'; // i18n-ignore
const PIP = 'You are Pip, a paper robot.\nBe concise.';

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

describe('SdkIPCClient · default system prompt comes from the kernel', () => {
  it('sends the kernel default system prompt verbatim', async () => {
    const { client, calls } = capture();
    const ipc = new SdkIPCClient(client as never, { defaultSystemPrompt: async () => PIP });
    await ipc.sendMessage('hi');
    expect(systemOf(calls[0]!)).toBe(PIP);
  });

  it('sends no system prompt when the kernel is unreachable', async () => {
    const { client, calls } = capture();
    const ipc = new SdkIPCClient(client as never, { defaultSystemPrompt: async () => undefined });
    await ipc.sendMessage('hi');
    expect(systemOf(calls[0]!)).toBeUndefined();
  });

  it('asks the kernel on every turn (pack / UI language switches apply at once)', async () => {
    const { client, calls } = capture();
    let prompt = 'You are Pip.';
    const ipc = new SdkIPCClient(client as never, { defaultSystemPrompt: async () => prompt });
    await ipc.sendMessage('hi');
    prompt = '你是小纸。';
    await ipc.sendMessage('hi', [], 'memory recall');
    expect(systemOf(calls[0]!)).toBe('You are Pip.');
    expect(systemOf(calls[1]!)).toBe('你是小纸。\n\nmemory recall');
  });

  it('treats the legacy stored i18n key as "not customised"', async () => {
    const { client, calls } = capture({ chat: { systemPrompt: LEGACY_KEY } });
    const ipc = new SdkIPCClient(client as never, { defaultSystemPrompt: async () => PIP });
    expect((await ipc.getConfig()).systemPrompt).toBeUndefined();
    await ipc.sendMessage('hi');
    expect(systemOf(calls[0]!)).toBe(PIP);
  });

  it('migrates the legacy key from local storage too, and does not persist it back', async () => {
    window.localStorage.setItem(
      'ai-chat:config',
      JSON.stringify({ theme: 'dark', systemPrompt: LEGACY_KEY }),
    );
    const { client } = capture();
    const ipc = new SdkIPCClient(client as never, { defaultSystemPrompt: async () => PIP });
    await ipc.updateConfig({ fontSize: 16 });
    const saved = JSON.parse(window.localStorage.getItem('ai-chat:config')!);
    expect(saved.systemPrompt).toBeUndefined();
    expect(saved.theme).toBe('dark');
  });

  it('keeps a user-written prompt (and an explicitly cleared one) as is', async () => {
    const { client, calls } = capture();
    const defaultSystemPrompt = vi.fn(async () => PIP);
    const ipc = new SdkIPCClient(client as never, { defaultSystemPrompt });
    await ipc.updateConfig({ systemPrompt: 'Custom prompt' });
    await ipc.sendMessage('hi');
    await ipc.updateConfig({ systemPrompt: '' });
    await ipc.sendMessage('hi');
    expect(systemOf(calls[0]!)).toBe('Custom prompt');
    expect(systemOf(calls[1]!)).toBeUndefined();
    expect(defaultSystemPrompt).not.toHaveBeenCalled();
  });

  it('reads the default prompt from the kernel (contract persona.systemPrompt) by default', async () => {
    const get = vi.fn(async () => PIP);
    installMascotHost({ 'persona.systemPrompt': () => get() });
    try {
      const { client, calls } = capture();
      const ipc = new SdkIPCClient(client as never);
      await ipc.sendMessage('hi');
      expect(get).toHaveBeenCalled();
      expect(systemOf(calls[0]!)).toBe(PIP);
    } finally {
      resetMascotHost();
    }
  });
});
