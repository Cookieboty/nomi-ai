// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PermissionCard } from '../src/components/Conversation/PermissionCard';
import { ApprovalCard } from '../src/components/ManagedRuntimeDock/ApprovalCard';
import {
  ManagedRuntimePanel,
  type ManagedRuntimeView,
} from '../src/components/ManagedRuntimeDock/panel';
import { acpCommandsToSlashCommands } from '../src/slash/acpCommands';
import { buildRegistry } from '../src/slash/registry';
import { applyLiveEvents } from '../src/utils/liveState';
import { classifyTool, diffsOf, reduceTrace } from '../src/utils/toolTrace';

afterEach(cleanup);

describe('ACP liveState extensions', () => {
  it('handles plan-removed, notice, commands, permission options, and working status', () => {
    const s1 = applyLiveEvents(
      undefined,
      [
        {
          tabId: 't1',
          type: 'plan',
          planId: 'p1',
          entries: [{ content: 'Step 1', status: 'in_progress' }],
        },
        { tabId: 't1', type: 'notice', tag: 'warn', text: 'Approaching quota' },
        {
          tabId: 't1',
          type: 'commands',
          commands: [{ name: 'audit', description: 'Audit code', hint: '[dir]' }],
        },
        {
          tabId: 't1',
          type: 'permission',
          id: 'perm-1',
          summary: 'Run rm',
          options: [
            { id: 'opt-allow', kind: 'allow_once', name: 'Allow once' },
            { id: 'opt-deny', kind: 'reject_once', name: 'Reject once' },
          ],
        },
        { tabId: 't1', type: 'status', kind: 'working', text: 'Analyzing repo' },
      ],
      1000,
    );

    expect(s1.trace).toHaveLength(1);
    expect(s1.notice).toEqual({ tag: 'warn', text: 'Approaching quota', at: 1000 });
    expect(s1.commands).toEqual([{ name: 'audit', description: 'Audit code', hint: '[dir]' }]);
    expect(s1.permissions?.[0]?.options).toHaveLength(2);
    expect(s1.status).toMatchObject({ kind: 'working', text: 'Analyzing repo' });

    const s2 = applyLiveEvents(s1, [{ tabId: 't1', type: 'plan-removed', planId: 'p1' }], 1050);
    expect(s2.trace).toHaveLength(0);
  });
});

describe('ACP toolTrace extensions', () => {
  it('updates running tool output, parses unified diff from output without stale cache, and classifies terminal', () => {
    expect(classifyTool('terminal')).toBe('command');

    const eStart = {
      type: 'tool' as const,
      id: 'tc-1',
      name: 'edit_file',
      status: 'start' as const,
      input: '{"file_path":"foo.ts"}',
    };
    const eChunk = {
      type: 'tool' as const,
      id: 'tc-1',
      name: 'edit_file',
      status: 'start' as const,
      output: '--- foo.ts\n+++ foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new',
    };

    const entriesBefore = reduceTrace([eStart]);
    expect(entriesBefore[0]?.type).toBe('tool');
    if (entriesBefore[0]?.type !== 'tool') throw new Error('expected tool entry');
    expect(diffsOf(entriesBefore[0].call)).toEqual([]);

    const entriesAfter = reduceTrace([eStart, eChunk]);
    if (entriesAfter[0]?.type !== 'tool') throw new Error('expected tool entry');
    const diffs = diffsOf(entriesAfter[0].call);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.file).toBe('foo.ts');
    expect(diffs[0]?.diff).toMatchObject({ added: 1, removed: 1 });
  });
});

describe('ACP multi-option permission cards and dynamic slash commands', () => {
  it('renders PermissionCard option buttons and forwards optionId', () => {
    const onReply = vi.fn();
    render(
      <PermissionCard
        summary="Edit file"
        options={[
          { id: 'allow-always', kind: 'allow_always', name: 'Always allow' },
          { id: 'reject-once', kind: 'reject_once', name: 'Reject once' },
        ]}
        onReply={onReply}
      />,
    );
    fireEvent.click(screen.getByTestId('conv-permission-option-allow-always'));
    expect(onReply).toHaveBeenCalledWith(true, 'allow-always');
    fireEvent.click(screen.getByTestId('conv-permission-option-reject-once'));
    expect(onReply).toHaveBeenCalledWith(false, 'reject-once');
  });

  it('renders ApprovalCard option buttons and ManagedRuntimePanel notice', () => {
    const onApprove = vi.fn();
    render(
      <ApprovalCard
        approvals={[
          {
            id: 'ap-opt',
            tool: 'run_shell',
            options: [
              { id: 'opt-1', kind: 'allow_once', name: 'Allow once' },
              { id: 'opt-2', kind: 'reject_always', name: 'Never allow' },
            ],
          },
        ]}
        onApprove={onApprove}
      />,
    );
    fireEvent.click(screen.getByTestId('managed-approval-option-ap-opt-opt-1'));
    expect(onApprove).toHaveBeenCalledWith('ap-opt', true, 'opt-1');
    fireEvent.click(screen.getByTestId('managed-approval-option-ap-opt-opt-2'));
    expect(onApprove).toHaveBeenCalledWith('ap-opt', false, 'opt-2');

    const view: ManagedRuntimeView = {
      supported: true,
      managed: true,
      backend: 'antigravity',
      phase: 'running',
      recovery: 'new',
      generation: 1,
      detail: '',
      choices: [],
      busy: true,
      notice: { tag: 'info', text: 'Sandbox active', at: 123 },
    };
    render(<ManagedRuntimePanel view={view} onResolve={vi.fn()} />);
    expect(screen.getByTestId('managed-runtime-notice').textContent).toBe('Sandbox active');
  });

  it('converts ACP dynamic commands and deduplicates via buildRegistry', () => {
    const dynamic = acpCommandsToSlashCommands([
      { name: '/audit', description: 'Run audit', hint: '[target]' },
      { name: 'audit', description: 'Duplicate ignored' },
    ]);
    expect(dynamic).toHaveLength(1);
    const reg = buildRegistry(dynamic);
    expect(reg[0]).toMatchObject({
      id: 'endpoint:audit',
      name: 'audit',
      label: '/audit',
      args: { hint: '[target]' },
    });
  });
});
