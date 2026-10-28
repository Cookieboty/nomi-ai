/**
 * D4 客户端模块（kb / mem / sched / local / hub / ext）走契约（services/api）：
 * 导出的签名不变、位置参数打包成具名入参、契约错误码换回旧码、事件经 api.on、没有传输时的退路。
 */

import { ContractError } from '@nomi-ai/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { extClient } from '../src/services/extClient';
import { KbCallError, kbClient } from '../src/services/kbClient';
import { hubClient, localClient } from '../src/services/localClient';
import { MemCallError, memClient, memoryContext } from '../src/services/memClient';
import { schedClient } from '../src/services/schedClient';

import type { ApiMockState } from './helpers/knowledgeApi';

const mock = vi.hoisted(() => ({ transport: true }) as ApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/knowledgeApi')).createApiMock(mock),
);

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  mock.invoke = undefined;
  mock.transport = true;
});

describe('D4 客户端 · 契约', () => {
  it('位置参数 → 具名入参', async () => {
    const invoke = vi.fn(async (_name: string, _input: unknown) => true);
    mock.invoke = invoke;
    await kbClient.toggleSource('s1', false);
    await kbClient.docs('s1');
    await memClient.remove('fact', 'f1');
    await memClient.export('md');
    await schedClient.toggleTask('t1', true);
    await localClient.offline(true);
    await localClient.ollamaPull('qwen3');
    await extClient.skillToggle('pdf', false);
    await extClient.migrateImport([{ key: 'k', action: 'rename' }]);
    await hubClient.exportAll(['memory'], { 'ai-chat:x': [1] });
    expect(invoke.mock.calls).toEqual([
      ['kb.toggleSource', { id: 's1', enabled: false }],
      ['kb.docs', { sourceId: 's1', filter: '' }],
      ['mem.remove', { kind: 'fact', id: 'f1' }],
      ['mem.export', { format: 'md' }],
      ['sched.toggleTask', { id: 't1', enabled: true }],
      ['local.offline', { enabled: true }],
      ['local.ollamaPull', { name: 'qwen3' }],
      ['ext.skillToggle', { name: 'pdf', enabled: false }],
      ['ext.migrateImport', { items: [{ key: 'k', action: 'rename' }] }],
      ['hub.export', { include: ['memory'], conversations: { 'ai-chat:x': [1] } }],
    ]);
  });

  it('契约错误码换回旧码；其余域只看 message', async () => {
    mock.invoke = (name) => {
      if (name === 'kb.ask') throw new ContractError('KB_LOCAL_ONLY', '只用本地模型');
      if (name === 'mem.updateEpisode') throw new ContractError('MEM_NOT_FOUND', '已不存在');
      if (name === 'kb.state') throw new ContractError('UNAVAILABLE', 'no kb');
      throw new Error('Ollama 没有运行');
    };
    await expect(kbClient.ask('q', [])).rejects.toMatchObject({
      constructor: KbCallError,
      code: 'local_only',
      message: '只用本地模型',
    });
    await expect(kbClient.state()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(memClient.updateEpisode('e1', { title: 't' })).rejects.toMatchObject({
      constructor: MemCallError,
      code: 'not-found',
    });
    const e = await localClient.ollamaList().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe('Ollama 没有运行');
    expect((e as Error).name).toBe('Error');
  });

  it('事件经 api.on 推给订阅者，返回退订函数', async () => {
    const changed = vi.fn();
    const progress = vi.fn();
    const offA = kbClient.onChanged(changed);
    const offB = localClient.onProgress(progress);
    await tick();
    mock.router!.events.publish('kb.changed', null);
    mock.router!.events.publish('local.progress', { id: 'm', received: 1, total: 4 });
    await tick();
    offA();
    offB();
    await tick();
    mock.router!.events.publish('kb.changed', null);
    await tick();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ id: 'm', received: 1, total: 4 });
  });

  it('没有传输：available() 为 false，按原来的退路处理', async () => {
    mock.transport = false;
    const invoke = vi.fn();
    mock.invoke = invoke;
    expect(kbClient.available()).toBe(false);
    expect(memClient.available()).toBe(false);
    await expect(kbClient.state()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(memClient.state()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(schedClient.state()).rejects.toBeInstanceOf(Error);
    expect(await extClient.context()).toBe('');
    expect(await memoryContext('x')).toEqual({ text: '', used: [] });
    schedClient.activity();
    expect(kbClient.onChanged(() => undefined)()).toBeUndefined();
    await tick();
    expect(invoke).not.toHaveBeenCalled();
  });
});
