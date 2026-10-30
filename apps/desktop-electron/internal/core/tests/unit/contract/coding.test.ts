/**
 * D3（contract/coding.ts）：harness / cli / cliAccount / cliUpdate / delegate / agents / history
 * 的处理函数委派给服务、账号错误码换成契约码、dangerous 过程拒绝不可信调用者、编排器推送接到事件总线、
 * 服务发布契约事件。
 */

import { appContract } from '@nomi-ai/contract/app';
import { createTestClient } from '@nomi-ai/contract/testing';
import type { HostPorts } from '@nomi-ai/host-ports';

import { AccountError } from '../../../src/cli/accounts/AccountService';
import { createCodingHandlers } from '../../../src/contract/coding';
import type { CoreContractServices } from '../../../src/contract/services';
import type { ContractDeps } from '../../../src/contract/types';
import { createRecordingAppEvents } from '../../../src/core/appEvents';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const tab = {
  id: 't1',
  title: 'T',
  backend: 'claude',
  cwd: '/w',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 1,
  updatedAt: 2,
  modelOverride: 'm',
};
const tabs = { tabs: [tab], activeTabId: 't1', running: 0, queued: 0, codexNetwork: false };
const state = { backend: 'nomi', cwd: '/w', cliSessionId: null, busy: false, bins: {} };
const account = {
  id: 'a1',
  kind: 'claude',
  label: 'Work',
  identity: null,
  active: true,
  local: false,
  loggedIn: true,
  inUse: 0,
  createdAt: 1,
};

function fakes() {
  return {
    harness: {
      attachEvents: jest.fn(),
      stateFresh: jest.fn(async () => state),
      listTabs: jest.fn(() => tabs),
      createTab: jest.fn(() => tab),
      setTabCwd: jest.fn(() => tab),
      setTabSource: jest.fn(() => tab),
      applyTabPermissionMode: jest.fn(async () => ({ ...tab, degraded: false })),
      modelCatalogFor: jest.fn(async () => null),
      sendTabReply: jest.fn(async () => ({ text: 'ok', sessionId: 's1', durationMs: 5 })),
      gitCommitIn: jest.fn(async () => ({ ok: true, sha: 'abc' })),
      workspaceReadIn: jest.fn(() => ({ ok: true, content: 'x' })),
      tabContext: jest.fn(async () => null),
      pickDirectory: jest.fn(async () => null),
      answerPermission: jest.fn(() => true),
      answerApprovePlan: jest.fn(() => true),
      trustGeminiFolder: jest.fn(async () => ({ folder: '/w', file: '/f', previous: null })),
    },
    cliPlugins: {
      snapshot: jest.fn(() => ({ plugins: [] })),
      addExternal: jest.fn(() => ({ ok: false, errors: ['id must be lowercase'] })),
      testExternalInTemp: jest.fn(async () => ({ ok: false, errors: ['spawn failed'] })),
    },
    accounts: {
      list: jest.fn(() => [account]),
      setDefault: jest.fn(() => account),
      remove: jest.fn(async () => {
        throw new AccountError('unknown-live', '无法确认');
      }),
    },
    accountLogin: {
      start: jest.fn(async () => ({ id: 'l1', kind: 'claude', state: 'starting' })),
      openUrl: jest.fn(async () => false),
    },
    cliUpdate: {
      previewUpdate: jest.fn(async () => ({
        kind: 'codex',
        mode: 'update',
        scope: 'user',
        argv: ['npm'],
        command: 'npm',
        requirements: [],
        blockers: [],
      })),
      job: jest.fn(() => null),
      busyKinds: jest.fn(() => ['claude']),
    },
    delegate: {
      pin: jest.fn(() => 'codex'),
      clearPin: jest.fn(),
      statusOf: jest.fn(() => null),
    },
    agents: {
      scanNow: jest.fn(async () => ({
        settings: { enabled: true, stallMs: 1, cooldownMs: 1, summaryEnabled: false, tools: {} },
        sessions: [],
        detected: [],
        lastRemindAt: 0,
      })),
      setSettings: jest.fn(() => ({ enabled: true, stallMs: 1, cooldownMs: 1, tools: {} })),
    },
    history: {
      list: jest.fn(async () => ({ items: [], nextOffset: null, hasMore: false })),
      remove: jest.fn(async () => ({ ok: true, removed: 1 })),
    },
  };
}

function setup(trusted = true) {
  const f = fakes();
  const services: CoreContractServices = Object.assign({}, f as never);
  const events = createRecordingAppEvents();
  const deps: ContractDeps = { services, ports: {} as HostPorts, events, logger };
  const { api, close } = createTestClient(appContract, createCodingHandlers(deps), {
    caller: { surface: 'chat', trusted },
  });
  return {
    f,
    events,
    services,
    api,
    close,
  };
}

describe('contract/coding', () => {
  beforeEach(() => jest.clearAllMocks());

  it('建 router 时把应用事件总线接给编排器（推送发布契约事件）', () => {
    const { f, events, close } = setup();
    try {
      expect(f.harness.attachEvents).toHaveBeenCalledWith(events);
    } finally {
      close();
    }
  });

  it('harness：具名入参委派给编排器的公开方法，未知字段透传', async () => {
    const { f, api, close } = setup();
    try {
      expect(await api.harness.state()).toMatchObject({ backend: 'nomi', bins: {} });
      expect(await api.harness.tabs()).toMatchObject({ activeTabId: 't1', codexNetwork: false });
      const created = await api.harness.tabCreate({ backend: 'claude', cliSessionId: 'abc' });
      expect(created).toMatchObject({ id: 't1', modelOverride: 'm' });
      expect(f.harness.createTab).toHaveBeenCalledWith({ backend: 'claude', cliSessionId: 'abc' });
      await api.harness.tabCwd({ id: 't1', cwd: '/x' });
      expect(f.harness.setTabCwd).toHaveBeenCalledWith('t1', '/x', { carry: false });
      await api.harness.tabSource({ id: 't1', source: 'thirdParty' });
      expect(f.harness.setTabSource).toHaveBeenCalledWith('t1', 'thirdParty', undefined);
      expect(await api.harness.modelCatalog({ backend: 'codex', refresh: true })).toBeNull();
      expect(f.harness.modelCatalogFor).toHaveBeenCalledWith('codex', {
        refresh: true,
        source: 'official',
      });
      expect(await api.harness.tabSend({ id: 't1', prompt: 'hi' })).toEqual({
        text: 'ok',
        sessionId: 's1',
        durationMs: 5,
      });
      expect(f.harness.sendTabReply).toHaveBeenCalledWith('t1', 'hi', undefined);
      expect(await api.harness.gitCommit({ cwd: '/w', message: 'm' })).toMatchObject({
        ok: true,
        sha: 'abc',
      });
      expect(f.harness.gitCommitIn).toHaveBeenCalledWith('/w', 'm', undefined);
      expect(await api.harness.workspaceRead({ cwd: '/w', path: 'a.ts' })).toMatchObject({
        content: 'x',
      });
      expect(f.harness.workspaceReadIn).toHaveBeenCalledWith('/w', 'a.ts');
      expect(await api.harness.tabContext({ id: 't1' })).toBeNull();
      expect(await api.harness.pickDir({})).toBeNull();
      expect(f.harness.pickDirectory).toHaveBeenCalledWith(undefined);
    } finally {
      close();
    }
  });

  it('harness：回答确认的过程是 dangerous；受信调用方照常委派', async () => {
    const { f, api, close } = setup();
    try {
      expect(
        await api.harness.replyPermission({
          tabId: 't1',
          requestId: 'r1',
          allow: false,
          approvePlan: 'manual',
        }),
      ).toBe(true);
      expect(f.harness.answerPermission).toHaveBeenCalledWith('t1', 'r1', false, 'manual');
      await api.harness.replyApprovePlan({ tabId: 't1', requestId: 'r1', choice: 'deny' });
      expect(f.harness.answerApprovePlan).toHaveBeenCalledWith('t1', 'r1', 'deny');
      await api.harness.tabPermissionMode({
        id: 't1',
        mode: 'bypass',
        confirmed: true,
        expect: { backend: 'claude', cwd: '/w' },
      });
      expect(f.harness.applyTabPermissionMode).toHaveBeenCalledWith('t1', 'bypass', {
        confirmed: true,
        expect: { backend: 'claude', cwd: '/w' },
      });
      await api.harness.geminiTrustFolder({ tabId: 't1', messageId: 'm1', confirmed: true });
      expect(f.harness.trustGeminiFolder).toHaveBeenCalledWith('t1', 'm1', { confirmed: true });
      // 选项外的值在入参校验处被拒绝
      await expect(
        api.harness.replyApprovePlan({ tabId: 't1', requestId: 'r1', choice: 'yolo' as never }),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    } finally {
      close();
    }
  });

  it('dangerous：不可信调用者被拒绝（FORBIDDEN），服务不被调用', async () => {
    const { f, api, close } = setup(false);
    try {
      await expect(
        api.harness.replyPermission({ tabId: 't1', requestId: 'r1', allow: true }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api.harness.replyApprovePlan({ tabId: 't1', requestId: 'r1', choice: 'acceptEdits' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api.harness.tabPermissionMode({ id: 't1', mode: 'bypass', confirmed: true }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api.harness.geminiTrustFolder({ tabId: 't1', messageId: 'm1', confirmed: true }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.harness.answerPermission).not.toHaveBeenCalled();
      expect(f.harness.answerApprovePlan).not.toHaveBeenCalled();
      expect(f.harness.applyTabPermissionMode).not.toHaveBeenCalled();
      expect(f.harness.trustGeminiFolder).not.toHaveBeenCalled();
      // 非 dangerous 过程照常可用
      expect(await api.harness.tabs()).toMatchObject({ activeTabId: 't1' });
    } finally {
      close();
    }
  });

  it('cli / cliAccount / cliUpdate / delegate / agents / history 委派', async () => {
    const { f, api, close } = setup();
    try {
      expect(await api.cli.registry()).toEqual({ plugins: [] });
      const spec = { version: 1, id: 'my', displayName: 'My', command: 'my', args: [] };
      expect(await api.cli.pluginAdd({ spec })).toEqual({
        ok: false,
        errors: ['id must be lowercase'],
      });
      expect(f.cliPlugins.addExternal).toHaveBeenCalledWith(spec);
      expect(await api.cli.pluginTest({ spec })).toMatchObject({ ok: false });

      expect(await api.cliAccount.list({})).toEqual([account]);
      expect(f.accounts.list).toHaveBeenCalledWith(undefined);
      await api.cliAccount.setDefault({ kind: 'codex', id: 'a1' });
      expect(f.accounts.setDefault).toHaveBeenCalledWith('codex', 'a1');
      await expect(api.cliAccount.setDefault({ kind: 'nope', id: 'a1' })).rejects.toMatchObject({
        code: 'INTERNAL',
      });
      expect(await api.cliAccount.loginStart({ kind: 'claude' })).toMatchObject({ id: 'l1' });
      expect(f.accountLogin.start).toHaveBeenCalledWith('claude', undefined);
      expect(await api.cliAccount.openUrl({ url: 'https://evil.example' })).toBe(false);

      await api.cliUpdate.preview({ kind: 'codex', scope: 'user' });
      expect(f.cliUpdate.previewUpdate).toHaveBeenCalledWith('codex', 'user');
      expect(await api.cliUpdate.job({ kind: 'whatever' })).toBeNull();
      expect(f.cliUpdate.job).toHaveBeenCalledWith('claude');
      expect(await api.cliUpdate.busy()).toEqual(['claude']);

      expect(await api.delegate.pin({ cli: 'codex', turnId: 'r1' })).toBe('codex');
      expect(await api.delegate.clearPin({ turnId: 'r1' })).toBe(true);
      expect(f.delegate.clearPin).toHaveBeenCalledWith('r1');
      expect(await api.delegate.status({ taskId: 'x' })).toBeNull();

      expect(await api.agents.scan()).toMatchObject({ detected: [] });
      await api.agents.setSettings({ tools: { codex: false } });
      expect(f.agents.setSettings).toHaveBeenCalledWith({ tools: { codex: false } });

      await api.history.list({ backend: 'claude', options: { offset: 20 } });
      expect(f.history.list).toHaveBeenCalledWith('claude', { offset: 20 });
      await api.history.list({ backend: 'codex' });
      expect(f.history.list).toHaveBeenLastCalledWith('codex', {});
      expect(await api.history.delete({ backend: 'claude', sessionId: 's' })).toEqual({
        ok: true,
        removed: 1,
      });
    } finally {
      close();
    }
  });

  it('账号错误码 → 契约码（视图据此走控制流）', async () => {
    const { api, close } = setup();
    try {
      await expect(api.cliAccount.remove({ id: 'a1' })).rejects.toMatchObject({
        code: 'ACCOUNT_UNKNOWN_LIVE',
        message: '无法确认',
      });
    } finally {
      close();
    }
  });

  it('服务没创建：UNAVAILABLE', async () => {
    const { services, api, close } = setup();
    try {
      services.history = undefined;
      services.harness = undefined;
      await expect(api.history.list({ backend: 'claude' })).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
      await expect(api.harness.tabs()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      close();
    }
  });
});
