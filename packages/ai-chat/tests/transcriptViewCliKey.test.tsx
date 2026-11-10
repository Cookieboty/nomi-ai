// @vitest-environment happy-dom
/** #313：编程助手会话的 Transcript view 设置跟着 CLI 会话走，关掉标签、从历史重开（新标签 id）仍在 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useMigrateCliTranscriptView, useTranscriptView } from '../src/hooks/useTranscriptView';
import {
  cliTranscriptKey,
  getTranscriptView,
  migrateTranscriptView,
  resetTranscriptViewsForTest,
  setGlobalTranscriptView,
  setTranscriptView,
} from '../src/services/transcriptView';

beforeEach(() => resetTranscriptViewsForTest());

type Tab = Parameters<typeof cliTranscriptKey>[0];
const tab = (
  id: string,
  cliSessionId: string | null,
  backend = 'claude',
  pluginId?: string,
): Tab => ({
  id,
  backend,
  pluginId,
  cliSessionId,
});

/** App 里的用法：当前标签的键 + 拿到会话 id 后迁移 */
function useActiveTab(t: Tab) {
  useMigrateCliTranscriptView(t);
  return useTranscriptView(cliTranscriptKey(t));
}

describe('cliTranscriptKey', () => {
  it('uses the CLI session when there is one, namespaced by backend (and external plugin)', () => {
    expect(cliTranscriptKey(tab('t1', null))).toBe('tab:t1');
    expect(cliTranscriptKey(tab('t1', 's1'))).toBe('cli:claude:s1');
    expect(cliTranscriptKey(tab('t2', 's1'))).toBe('cli:claude:s1');
    expect(cliTranscriptKey(tab('t3', 's1', 'codex'))).toBe('cli:codex:s1');
    expect(cliTranscriptKey(tab('t4', 's1', 'external', 'p1'))).toBe('cli:external/p1:s1');
    expect(cliTranscriptKey(tab('t5', 's1', 'external', 'p2'))).toBe('cli:external/p2:s1');
  });

  it('migrate moves the override; an existing override on the target wins', () => {
    setTranscriptView('tab:a', 'verbose');
    migrateTranscriptView('tab:a', 'cli:claude:s');
    expect(getTranscriptView('cli:claude:s')).toBe('verbose');
    setTranscriptView('tab:b', 'normal');
    setTranscriptView('cli:claude:s2', 'verbose');
    migrateTranscriptView('tab:b', 'cli:claude:s2');
    expect(getTranscriptView('cli:claude:s2')).toBe('verbose');
    migrateTranscriptView('tab:none', 'cli:claude:s3');
    expect(getTranscriptView('cli:claude:s3')).toBe('thinking');
  });
});

describe('closing a tab and reopening the session from history', () => {
  it('keeps the setting even when it was chosen before the CLI session id existed', () => {
    setGlobalTranscriptView('normal');
    // 新标签还没发第一条：没有会话 id，先按标签存
    const r = renderHook((t: Tab) => useActiveTab(t), { initialProps: tab('t1', null) });
    act(() => r.result.current.setView('verbose'));
    expect(r.result.current.view).toBe('verbose');
    // 发了第一条，拿到会话 id：设置跟着搬过去
    r.rerender(tab('t1', 'sess-A'));
    expect(r.result.current.view).toBe('verbose');
    r.unmount();
    // 关掉标签，从历史重开：新标签 id、同一个会话
    const reopened = renderHook((t: Tab) => useActiveTab(t), { initialProps: tab('t9', 'sess-A') });
    expect(reopened.result.current.view).toBe('verbose');
    expect(reopened.result.current.hasOverride).toBe(true);
    // 「跟随全局设置」之后，全局的修改照常生效
    act(() => reopened.result.current.followGlobal());
    expect(reopened.result.current.view).toBe('normal');
    act(() => setGlobalTranscriptView('thinking'));
    expect(reopened.result.current.view).toBe('thinking');
  });

  it('other sessions, other backends and forks (new session id) are independent', () => {
    setGlobalTranscriptView('normal');
    setTranscriptView(cliTranscriptKey(tab('t1', 'sess-A')), 'verbose');
    expect(getTranscriptView(cliTranscriptKey(tab('t2', 'sess-B')))).toBe('normal');
    expect(getTranscriptView(cliTranscriptKey(tab('t3', 'sess-A', 'codex')))).toBe('normal');
    // 分叉出的会话有新的会话 id：不继承，跟随全局
    expect(getTranscriptView(cliTranscriptKey(tab('t4', 'sess-A-fork')))).toBe('normal');
  });
});
