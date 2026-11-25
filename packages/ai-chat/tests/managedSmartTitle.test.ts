// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setSmartTitle } from '../src/services/chatPrefs';
import { maybeStartManagedSmartTitle } from '../src/services/nomiSmartTitle';
import { clearNomiAutoTitle } from '../src/services/sessionTitle';
import type { IPCClient } from '../src/types/ipc';

function makeClient(
  initialName: string,
  completeChatText?: IPCClient['completeChatText'],
): {
  client: IPCClient;
  refreshManaged: ReturnType<typeof vi.fn>;
} {
  const meta = { id: 'c1', name: initialName };
  const refreshManaged = vi.fn(async () => undefined);
  const store = {
    get: (id: string) => (id === 'c1' ? meta : undefined),
    refreshManaged,
  };
  const client = {
    conversationStore: () => store,
    completeChatText,
  } as unknown as IPCClient;
  return { client, refreshManaged };
}

describe('maybeStartManagedSmartTitle', () => {
  beforeEach(() => {
    clearNomiAutoTitle('c1');
    setSmartTitle(true);
  });

  it('uses completeChatText for managed api backend and sends autoTitle: true', async () => {
    const completeChatText = vi.fn(async () => '构建修复总结');
    const { client, refreshManaged } = makeClient('新对话', completeChatText);
    const updateMeta = vi.fn(async () => undefined);
    const notify = vi.fn();

    await maybeStartManagedSmartTitle(client, 'c1', '帮我看下打包脚本为什么报错了', {
      enabled: () => true,
      getRuntimeState: async () => ({ backend: 'api', model: 'anthropic/claude-sonnet' }),
      updateMeta,
      notify,
    });

    expect(completeChatText).toHaveBeenCalledOnce();
    expect(updateMeta).toHaveBeenCalledWith('c1', { name: '构建修复总结', autoTitle: true });
    expect(refreshManaged).toHaveBeenCalledWith('c1');
    expect(notify).toHaveBeenCalledOnce();
  });

  it('uses thirdParty model ref for managed CLI thirdParty sessions', async () => {
    const completeChatText = vi.fn(async () => 'should not be called');
    const { client } = makeClient('帮我重构路由模块', completeChatText);
    const cliInner = vi.fn(async () => '重构路由模块');
    const cliComplete = vi.fn(() => cliInner);
    const updateMeta = vi.fn(async () => undefined);

    await maybeStartManagedSmartTitle(client, 'c1', '帮我重构路由模块', {
      enabled: () => true,
      getRuntimeState: async () => ({
        backend: 'codex',
        source: 'thirdParty',
        model: 'acme/coder-v2',
      }),
      cliComplete,
      updateMeta,
      notify: vi.fn(),
    });

    expect(completeChatText).not.toHaveBeenCalled();
    expect(cliComplete).toHaveBeenCalledWith('acme/coder-v2');
    expect(cliInner).toHaveBeenCalledOnce();
    expect(updateMeta).toHaveBeenCalledWith('c1', { name: '重构路由模块', autoTitle: true });
  });

  it('skips LLM requests for local and official managed CLI sessions', async () => {
    const completeChatText = vi.fn(async () => 'nope');
    const cliComplete = vi.fn();
    const updateMeta = vi.fn();

    for (const source of ['local', 'official'] as const) {
      clearNomiAutoTitle('c1');
      const { client } = makeClient('新对话', completeChatText);
      await maybeStartManagedSmartTitle(client, 'c1', '帮我写单元测试', {
        enabled: () => true,
        getRuntimeState: async () => ({ backend: 'claude', source, model: 'claude-sonnet-4' }),
        cliComplete,
        updateMeta,
      });
    }

    expect(completeChatText).not.toHaveBeenCalled();
    expect(cliComplete).not.toHaveBeenCalled();
    expect(updateMeta).not.toHaveBeenCalled();
  });

  it('respects privacy toggle off without sending any request', async () => {
    setSmartTitle(false);
    const completeChatText = vi.fn(async () => 'nope');
    const { client } = makeClient('新对话', completeChatText);
    const getRuntimeState = vi.fn();
    const updateMeta = vi.fn();

    await maybeStartManagedSmartTitle(client, 'c1', '你好', {
      getRuntimeState,
      updateMeta,
    });

    expect(getRuntimeState).not.toHaveBeenCalled();
    expect(completeChatText).not.toHaveBeenCalled();
    expect(updateMeta).not.toHaveBeenCalled();
  });

  it('does not apply smart title if clearNomiAutoTitle ran during generation (manual rename)', async () => {
    const { client } = makeClient('新对话', async () => {
      clearNomiAutoTitle('c1');
      return '不该写入的标题';
    });
    const updateMeta = vi.fn();

    await maybeStartManagedSmartTitle(client, 'c1', '给我取个名字', {
      enabled: () => true,
      getRuntimeState: async () => ({ backend: 'api', model: 'acme/m' }),
      updateMeta,
    });

    expect(updateMeta).not.toHaveBeenCalled();
  });
});
