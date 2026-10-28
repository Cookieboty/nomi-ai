/**
 * D4（contract/knowledge.ts）：kb / mem / sched / local / hub / ext 的处理函数委派给服务、
 * 服务错误码换成契约码、dangerous 过程拒绝不可信调用者。
 */

import { appContract } from '@nomi-ai/contract/app';
import { createTestClient } from '@nomi-ai/contract/testing';
import type { HostPorts } from '@nomi-ai/host-ports';

import { createKnowledgeHandlers, knowledgeErrorCode } from '../../../src/contract/knowledge';
import type { CoreContractServices } from '../../../src/contract/services';
import type { ContractDeps } from '../../../src/contract/types';
import { createRecordingAppEvents } from '../../../src/core/appEvents';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const progress = {
  running: true,
  phase: 'scan',
  done: 0,
  total: 0,
  added: 0,
  updated: 0,
  removed: 0,
  failed: 0,
};

function fakes() {
  return {
    kb: {
      setSourceEnabled: jest.fn(() => true),
      startReindex: jest.fn(() => progress),
      askFromView: jest.fn(async () => {
        throw new CodedError('local_only', '只用本地模型');
      }),
      consentCloud: jest.fn(() => true),
      docs: jest.fn(() => []),
      open: jest.fn(async () => ({ ok: true })),
    },
    mem: {
      updateEpisode: jest.fn(async () => {
        throw new CodedError('not-found', '这条记忆已不存在');
      }),
      ingestFromView: jest.fn(async () => ({ skipped: 'auto-off' })),
      context: jest.fn(async () => ({ text: 'ctx', used: [] })),
      remove: jest.fn(() => true),
      profile: jest.fn(() => undefined),
    },
    sched: {
      noteActivity: jest.fn(),
      setTaskEnabled: jest.fn(() => true),
      proactiveNow: jest.fn(async () => {
        throw new CodedError('empty', '没想到说什么');
      }),
      upsertTask: jest.fn(() => {
        const e = new Error('ENOENT: no such file') as Error & { code: string };
        e.code = 'ENOENT';
        throw e;
      }),
    },
    localModels: {
      downloadRuntime: jest.fn(async () => ({ ok: true })),
      setOffline: jest.fn(async (on: boolean) => on),
      ollamaPull: jest.fn(async () => {
        throw new Error('Ollama 没有运行');
      }),
    },
    localHub: { exportAll: jest.fn(async () => null) },
    ext: {
      toggleSkill: jest.fn(() => true),
      openSkill: jest.fn(async () => ''),
      migrateScan: jest.fn(async () => ({ project: null, sources: [], mcp: [], skills: [] })),
      disconnect: jest.fn(async () => undefined),
    },
  };
}

function setup(trusted = true) {
  const f = fakes();
  const services: CoreContractServices = Object.assign({}, f as never);
  const deps: ContractDeps = {
    services,
    ports: {} as HostPorts,
    events: createRecordingAppEvents(),
    logger,
  };
  const { api, close } = createTestClient(appContract, createKnowledgeHandlers(deps), {
    caller: { surface: 'chat', trusted },
  });
  return {
    f,
    services,
    api,
    close,
  };
}

describe('contract/knowledge', () => {
  beforeEach(() => jest.clearAllMocks());

  it('具名入参委派给服务的公开方法', async () => {
    const { f, api, close } = setup();
    try {
      expect(await api.kb.toggleSource({ id: 's1', enabled: true })).toBe(true);
      expect(f.kb.setSourceEnabled).toHaveBeenCalledWith('s1', true);
      expect(await api.kb.reindex({ force: true })).toMatchObject({ phase: 'scan' });
      expect(f.kb.startReindex).toHaveBeenCalledWith(true);
      await api.kb.docs({ sourceId: 's1' });
      expect(f.kb.docs).toHaveBeenCalledWith('s1', '');
      await api.kb.open({ docId: 'd1' });
      expect(f.kb.open).toHaveBeenCalledWith('d1', 'open');

      const msgs = [{ role: 'user', content: 'hi' }];
      expect(await api.mem.ingest({ conversationId: 'c1', messages: msgs })).toEqual({
        skipped: 'auto-off',
      });
      expect(f.mem.ingestFromView).toHaveBeenCalledWith('c1', msgs, false);
      await api.mem.context({ q: 'x'.repeat(5000) });
      expect((f.mem.context.mock.calls[0] as unknown[])[0]).toHaveLength(4000);
      expect(await api.mem.remove({ kind: 'fact', id: 'f1' })).toBe(true);
      expect(f.mem.remove).toHaveBeenCalledWith('fact', 'f1');
      expect(await api.mem.profile()).toBeNull();

      expect(await api.sched.activity()).toBe(true);
      expect(f.sched.noteActivity).toHaveBeenCalled();
      await api.sched.toggleTask({ id: 't1', enabled: false });
      expect(f.sched.setTaskEnabled).toHaveBeenCalledWith('t1', false);

      expect(await api.local.downloadRuntime()).toEqual({ ok: true });
      expect(await api.hub.export({ include: ['memory'] })).toBeNull();
      expect(f.localHub.exportAll).toHaveBeenCalledWith({
        include: ['memory'],
        conversations: undefined,
      });

      await api.ext.skillToggle({ name: 'pdf', enabled: false });
      expect(f.ext.toggleSkill).toHaveBeenCalledWith('pdf', false);
      expect(await api.ext.skillOpen({})).toBe('');
      expect(f.ext.openSkill).toHaveBeenCalledWith(undefined);
      await api.ext.migrateScan({ pickProject: true });
      expect(f.ext.migrateScan).toHaveBeenCalledWith({ pickProject: true, clearProject: false });
      expect(await api.ext.mcpDisconnect({ id: 'm1' })).toBeUndefined();
    } finally {
      close();
    }
  });

  it('服务错误码 → 契约码；未声明的码与普通异常原样（INTERNAL，消息保留）', async () => {
    const { api, close } = setup();
    try {
      await expect(api.kb.ask({ q: 'q', history: [] })).rejects.toMatchObject({
        code: 'KB_LOCAL_ONLY',
        message: '只用本地模型',
      });
      await expect(api.mem.updateEpisode({ id: 'e', patch: {} })).rejects.toMatchObject({
        code: 'MEM_NOT_FOUND',
      });
      await expect(api.sched.proactiveNow()).rejects.toMatchObject({ code: 'SCHED_EMPTY' });
      await expect(api.sched.upsertTask({ name: 'x' })).rejects.toMatchObject({
        code: 'INTERNAL',
        message: 'ENOENT: no such file',
      });
      await expect(api.local.ollamaPull({ name: 'qwen' })).rejects.toMatchObject({
        code: 'INTERNAL',
        message: 'Ollama 没有运行',
      });
    } finally {
      close();
    }
  });

  it('knowledgeErrorCode 只换声明过的码', () => {
    expect(knowledgeErrorCode('KB', new CodedError('user_denied', 'x'))).toBe('KB_USER_DENIED');
    expect(knowledgeErrorCode('MEM', new CodedError('bad-summary', 'x'))).toBe('MEM_BAD_SUMMARY');
    expect(knowledgeErrorCode('SCHED', new CodedError('nope', 'x'))).toBeNull();
    expect(knowledgeErrorCode('KB', { code: 'denied' })).toBeNull();
  });

  it('dangerous：不可信调用者被拒绝（FORBIDDEN），服务不被调用', async () => {
    const { f, api, close } = setup(false);
    try {
      await expect(api.kb.consentCloud({ providerId: 'p' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(api.local.offline({ enabled: true })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(f.kb.consentCloud).not.toHaveBeenCalled();
      expect(f.localModels.setOffline).not.toHaveBeenCalled();
      // 非 dangerous 过程照常可用
      expect(await api.kb.toggleSource({ id: 's', enabled: true })).toBe(true);
    } finally {
      close();
    }
  });

  it('服务没创建：UNAVAILABLE', async () => {
    const { services, api, close } = setup();
    try {
      services.kb = undefined;
      await expect(api.kb.state()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      close();
    }
  });
});
