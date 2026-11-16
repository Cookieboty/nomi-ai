// @vitest-environment happy-dom
/**
 * 子任务改的文件回到来源对话：结果消息正文列文件 + 增删行数（Nomi 下一轮读得到），
 * 消息下面是和子任务面板同一张「已编辑 N 个文件」卡片（点开看每个文件的 Diff）。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nomiSlots } from '../src/components/Conversation/nomiSlots';
import { ChangesUiProvider } from '../src/components/SessionWorkspace';
import {
  collectDelegateChanges,
  matchDelegateChanges,
  type DelegateChanges,
} from '../src/services/delegateChanges';
import type { DelegateResult } from '../src/services/delegateClient';
import { delegateResultMessage } from '../src/services/delegateMessage';
import type { HarnessTabMessage, HarnessTabsState } from '../src/services/harnessClient';
import { fromChatMessage } from '../src/utils/convAdapters';

const tabMessages = vi.fn<(id: string) => Promise<HarnessTabMessage[]>>();
vi.mock('../src/services/harnessClient', async (original) => ({
  ...((await original()) as object),
  harnessClient: {
    tabMessages: (id: string) => tabMessages(id),
    workspaceRead: vi.fn(),
    workspaceWrite: vi.fn(),
    workspaceDelete: vi.fn(),
    workspaceGitCheckout: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  tabMessages.mockReset();
});

const NOW = 1_000_000;
const CWD = '/repo';

const edit = (file: string, oldText: string, newText: string) => ({
  type: 'tool' as const,
  name: 'Edit',
  status: 'done' as const,
  input: JSON.stringify({ file_path: file, old_string: oldText, new_string: newText }),
});
const write = (file: string, content: string) => ({
  type: 'tool' as const,
  name: 'Write',
  status: 'done' as const,
  input: JSON.stringify({ file_path: file, content }),
});

/** 子任务标签的会话：更早一轮改过 old.go，这一轮改了 upstream_protocol.go、新建了测试 */
const CHILD: HarnessTabMessage[] = [
  { id: 'u0', role: 'user', content: '先前的任务', timestamp: NOW - 60_000 } as HarnessTabMessage,
  {
    id: 'a0',
    role: 'assistant',
    content: '改好了',
    timestamp: NOW - 59_000,
    trace: [edit(`${CWD}/old.go`, 'a\n', 'b\n')],
  } as HarnessTabMessage,
  {
    id: 'u1',
    role: 'user',
    content: '修协议并补测试',
    timestamp: NOW - 4_000,
  } as HarnessTabMessage,
  {
    id: 'a1',
    role: 'assistant',
    content: '改好了，加了测试',
    timestamp: NOW - 3_000,
    trace: [
      edit(`${CWD}/internal/upstream_protocol.go`, 'x\ny\n', 'x2\ny2\nz2\n'),
      write(`${CWD}/internal/upstream_protocol_test.go`, 'package x\n\nfunc TestA() {}\n'),
    ],
  } as HarnessTabMessage,
];

const TABS: HarnessTabsState = {
  tabs: [
    {
      id: 'tab_1',
      title: 'Claude Code',
      backend: 'claude',
      cwd: CWD,
      cliSessionId: null,
      status: 'idle',
      unread: 0,
      createdAt: 0,
      updatedAt: 0,
      delegation: {
        by: 'nomi',
        goal: '修协议',
        taskId: 't1',
        approvals: { asked: 0, denied: 0, timedOut: 0 },
      },
    } as HarnessTabsState['tabs'][number],
  ],
  activeTabId: 'main',
  running: 0,
  queued: 0,
};

const result = (over: Partial<DelegateResult> = {}): DelegateResult => ({
  taskId: 't1',
  cli: 'claude',
  status: 'done',
  summary: '<cli-output>\nx\n改好了，加了测试\n</cli-output>',
  filesVerified: false,
  approvals: { asked: 0, denied: 0, timedOut: 0 },
  durationMs: 5_000,
  followUp: true,
  changedFiles: ['internal/upstream_protocol.go', 'internal/upstream_protocol_test.go'],
  ...over,
});

describe('delegate changes back in the source chat', () => {
  it('reads +/− of the files the kernel listed from the child session of this run only', async () => {
    tabMessages.mockResolvedValue(CHILD);
    const changes = await collectDelegateChanges(result(), {
      tabs: async () => TABS,
      tabMessages,
      now: () => NOW,
    });
    expect(tabMessages).toHaveBeenCalledWith('tab_1');
    expect(changes?.tabId).toBe('tab_1');
    expect(changes?.cwd).toBe(CWD);
    const files = changes!.files;
    expect(files.map((f) => f.file)).toEqual([
      'internal/upstream_protocol.go',
      'internal/upstream_protocol_test.go',
    ]);
    expect(files[0]!.added! + files[0]!.removed!).toBeGreaterThan(0);
    expect(files[1]!.added).toBe(3);
    expect(files[1]!.removed).toBe(0);
    // old.go 是更早一轮改的：内核没列、时间也不在这一轮里，不算
    expect(files.some((f) => f.file.includes('old.go'))).toBe(false);
  });

  it('puts the file list with counts into the message the main model reads, not the diff', async () => {
    tabMessages.mockResolvedValue(CHILD);
    const r = result();
    const changes = await collectDelegateChanges(r, {
      tabs: async () => TABS,
      tabMessages,
      now: () => NOW,
    });
    const m = delegateResultMessage(r, NOW, changes);
    const f0 = changes!.files[0]!;
    expect(m.content).toContain(
      `- \`internal/upstream_protocol.go\` (+${f0.added} −${f0.removed})`,
    );
    expect(m.content).toContain('- `internal/upstream_protocol_test.go` (+3 −0)');
    expect(m.content).not.toContain('func TestA');
    expect(m.delegateChanges?.files).toHaveLength(2);
  });

  it('still lists the files (without counts) when the child tab cannot be read', async () => {
    const changes = await collectDelegateChanges(result({ tabId: 'gone' }), {
      tabs: async () => ({ ...TABS, tabs: [] }),
      tabMessages: async () => {
        throw new Error('no such tab');
      },
      now: () => NOW,
    });
    expect(changes?.files).toEqual([
      { file: 'internal/upstream_protocol.go' },
      { file: 'internal/upstream_protocol_test.go' },
    ]);
    const m = delegateResultMessage(result(), NOW, changes);
    expect(m.content).toContain('- `internal/upstream_protocol.go`\n');
  });

  it('failed / stopped runs carry what they already changed', async () => {
    tabMessages.mockResolvedValue(CHILD);
    const r = result({ status: 'error', error: 'stopped' });
    const changes = await collectDelegateChanges(r, {
      tabs: async () => TABS,
      tabMessages,
      now: () => NOW,
    });
    const m = delegateResultMessage(r, NOW, changes);
    expect(m.content).toContain('internal/upstream_protocol_test.go` (+3 −0)');
    expect(m.delegateChanges?.files).toHaveLength(2);
  });

  it('no changed files: no lookup, no card', async () => {
    const tabs = vi.fn(async () => TABS);
    expect(
      await collectDelegateChanges(result({ changedFiles: [] }), { tabs, tabMessages }),
    ).toBeNull();
    expect(tabs).not.toHaveBeenCalled();
    expect(delegateResultMessage(result({ changedFiles: [] })).delegateChanges).toBeUndefined();
  });

  it('matches absolute child paths to the relative kernel list', () => {
    const { files, entries } = matchDelegateChanges(
      ['a.go', 'ran-by-command.txt'],
      [
        {
          id: 'x',
          role: 'assistant',
          text: '',
          at: 1,
          trace: [edit(`${CWD}/a.go`, 'a\n', 'b\n')],
        },
      ],
      CWD,
      'm1',
    );
    expect(files[0]).toMatchObject({ file: 'a.go', added: 1, removed: 1 });
    expect(files[1]).toEqual({ file: 'ran-by-command.txt' });
    expect(entries[0]!.file).toBe('a.go');
    expect(entries[0]!.diff).toBeTruthy();
    expect(entries.every((e) => e.messageId === 'm1')).toBe(true);
  });

  it('renders the same edited-files card under the result message, with each file diff', async () => {
    tabMessages.mockResolvedValue(CHILD);
    const changes: DelegateChanges = {
      tabId: 'tab_1',
      cwd: CWD,
      backend: 'claude',
      from: NOW - 6_000,
      to: NOW + 1_000,
      files: [
        { file: 'internal/upstream_protocol.go', added: 3, removed: 2 },
        { file: 'internal/upstream_protocol_test.go', added: 3, removed: 0 },
      ],
    };
    const msg = delegateResultMessage(result(), NOW, changes);
    const conv = fromChatMessage(msg)!;
    render(<ChangesUiProvider>{nomiSlots.after!(conv)}</ChangesUiProvider>);
    const card = await screen.findByTestId('turn-edit-summary');
    expect(card.textContent).toContain('2');
    expect(screen.getByTestId('delegate-changes')).toBeTruthy();
    await waitFor(() => expect(tabMessages).toHaveBeenCalledWith('tab_1'));
    expect(screen.getByTestId('turn-view-changes')).toBeTruthy();
  });
});
