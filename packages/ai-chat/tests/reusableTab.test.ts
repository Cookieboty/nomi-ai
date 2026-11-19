/** 新建 CLI 对话：同一个项目里这个端已经有没说话的空标签就复用，不再一个劲新建 */
import { describe, expect, it } from 'vitest';

import type { HarnessTabMeta } from '../src/services/harnessClient';
import { findReusableTab, isEmptyTab } from '../src/utils/reusableTab';

const tab = (patch: Partial<HarnessTabMeta> & Pick<HarnessTabMeta, 'id'>): HarnessTabMeta => ({
  title: 'Claude Code',
  backend: 'claude',
  cwd: '/tmp/app',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe('findReusableTab', () => {
  it('同一个项目里没说话的空标签直接复用', () => {
    const empty = tab({ id: 't1', projectId: 'p_app' });
    const used = tab({ id: 't2', projectId: 'p_app', cliSessionId: 'sess-1' });
    expect(findReusableTab([used, empty], 'claude', 'p_app')).toBe(empty);
  });

  it('换端或换项目不复用', () => {
    const empty = tab({ id: 't1', projectId: 'p_app' });
    expect(findReusableTab([empty], 'codex', 'p_app')).toBeUndefined();
    expect(findReusableTab([empty], 'claude', 'p_other')).toBeUndefined();
    expect(findReusableTab([empty], 'claude')).toBeUndefined();
  });

  it('不放进项目的空标签只和不带项目的请求配', () => {
    const loose = tab({ id: 't1' });
    expect(findReusableTab([loose], 'claude')).toBe(loose);
    expect(findReusableTab([loose], 'claude', 'p_app')).toBeUndefined();
  });

  it('正在跑 / 排队 / 报错 / 委派出来的标签不算空', () => {
    expect(findReusableTab([tab({ id: 't1', status: 'running' })], 'claude')).toBeUndefined();
    expect(findReusableTab([tab({ id: 't1', status: 'queued' })], 'claude')).toBeUndefined();
    expect(findReusableTab([tab({ id: 't1', status: 'error' })], 'claude')).toBeUndefined();
    expect(
      findReusableTab(
        [
          tab({
            id: 't1',
            delegation: {
              by: 'nomi',
              goal: '架子',
              approvals: { asked: 0, denied: 0, timedOut: 0 },
            },
          }),
        ],
        'claude',
      ),
    ).toBeUndefined();
  });

  it('isEmptyTab：跑过一轮的空标签（有 cliSessionId）不算空', () => {
    expect(isEmptyTab(tab({ id: 't1' }))).toBe(true);
    expect(isEmptyTab(tab({ id: 't1', cliSessionId: 'sess-1' }))).toBe(false);
  });

  it('没有标签时返回 undefined', () => {
    expect(findReusableTab(undefined, 'claude')).toBeUndefined();
    expect(findReusableTab([], 'claude')).toBeUndefined();
  });
});
