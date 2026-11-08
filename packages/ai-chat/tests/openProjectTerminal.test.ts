// @vitest-environment happy-dom
/** 快捷键「在终端打开当前项目」：没有项目目录、目录不认、找不到终端时都告诉用户 */
import { ContractError } from '@nomi-ai/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openProjectTerminal } from '../src/services/openProjectTerminal';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => resetFakeApi());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('openProjectTerminal', () => {
  it('没有项目目录：不调内核，提示先选工作区', () => {
    const notify = vi.fn();
    const invoke = vi.fn();
    installFakeApi(invoke);
    openProjectTerminal(null, notify);
    expect(invoke).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]![0]).toContain('工作区');
  });

  it('把目录交给内核；目录不认 / 找不到终端时说明原因', async () => {
    const notify = vi.fn();
    let code = '';
    const calls: unknown[] = [];
    installFakeApi(async (ch: string, input?: unknown) => {
      if (ch !== 'harness.openTerminal') return true;
      calls.push(input);
      if (code) throw new ContractError(code as never, 'too broad');
      return true;
    });
    openProjectTerminal('/w/app', notify);
    await flush();
    expect(calls).toEqual([{ cwd: '/w/app' }]);
    expect(notify).not.toHaveBeenCalled();
    code = 'TERMINAL_CWD_DENIED';
    openProjectTerminal('/', notify);
    await flush();
    expect(notify.mock.calls.at(-1)![0]).toContain('too broad');
    code = 'TERMINAL_NOT_FOUND';
    openProjectTerminal('/w/app', notify);
    await flush();
    expect(notify.mock.calls.at(-1)![0]).toContain('终端');
  });
});
