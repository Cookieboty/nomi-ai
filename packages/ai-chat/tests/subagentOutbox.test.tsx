// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import {
  SubagentOutboxProvider,
  useSubagentOutbox,
  type OutboxTarget,
} from '../src/contexts/SubagentOutboxContext';
import type { HarnessImageInput } from '../src/services/harnessClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
afterEach(() => {
  cleanup();
  resetFakeApi();
});

const target: OutboxTarget = { kind: 'nomi-task', taskId: 'task-1' };
const image = (i: number): HarnessImageInput => ({ mime: 'image/png', data: btoa(`image-${i}`) });

function Producer({ to = target, images }: { to?: OutboxTarget; images?: HarnessImageInput[] }) {
  const box = useSubagentOutbox(to);
  return (
    <>
      <button data-testid="enqueue" onClick={() => box.enqueue('message', images)}>
        enqueue
      </button>
      <button
        data-testid="enqueue-images"
        onClick={() => {
          for (let i = 0; i < 9; i++) box.enqueue(`message-${i}`, [image(i)]);
        }}
      >
        images
      </button>
      <button data-testid="retry" onClick={box.retry}>
        retry
      </button>
      <span data-testid="count">{box.items.length}</span>
      <span data-testid="error">{box.error}</span>
    </>
  );
}
const mount = (producer: React.ReactNode = <Producer />) =>
  render(
    <HarnessTabsProvider>
      <SubagentOutboxProvider>{producer}</SubagentOutboxProvider>
    </HarnessTabsProvider>,
  );

describe('SubagentOutboxProvider', () => {
  it('preserves attachments after failure and retries only when requested', async () => {
    let allowed = false;
    const fake = installFakeApi((name) => {
      if (name === 'harness.tabs') return { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
      if (name === 'tasks.get') return { task: { status: 'done' }, attempts: [] };
      if (name === 'tasks.followUp')
        return allowed ? { ok: true } : { ok: false, reason: 'expired' };
      return true;
    });
    mount(<Producer images={[image(1)]} />);
    fireEvent.click(screen.getByTestId('enqueue'));
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('expired'));
    await fake.emit('tasks.changed', {});
    expect(fake.inputs('tasks.followUp')).toHaveLength(1);
    expect(screen.getByTestId('count').textContent).toBe('1');
    allowed = true;
    fireEvent.click(screen.getByTestId('retry'));
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0'));
    expect(fake.inputs('tasks.followUp')).toEqual([
      { id: 'task-1', text: 'message', images: [image(1)] },
      { id: 'task-1', text: 'message', images: [image(1)] },
    ]);
  });

  it('does not lose the ninth image when merging queued messages', async () => {
    let status = 'running';
    const fake = installFakeApi((name) => {
      if (name === 'harness.tabs') return { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
      if (name === 'tasks.get') return { task: { status }, attempts: [] };
      if (name === 'tasks.followUp') return { ok: true };
      return true;
    });
    mount();
    fireEvent.click(screen.getByTestId('enqueue-images'));
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('9'));
    status = 'done';
    await fake.emit('tasks.changed', {});
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0'));
    const sent = fake.inputs('tasks.followUp') as Array<{
      text: string;
      images: HarnessImageInput[];
    }>;
    expect(sent).toHaveLength(2);
    expect(sent.map((batch) => batch.images.length)).toEqual([8, 1]);
    expect(sent.flatMap((batch) => batch.images)).toEqual(
      Array.from({ length: 9 }, (_, i) => image(i)),
    );
  });

  it('acknowledges only the in-flight batch and sends newly queued messages once', async () => {
    let finish!: (value: unknown) => void;
    let sends = 0;
    const fake = installFakeApi((name) => {
      if (name === 'harness.tabs') return { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
      if (name === 'tasks.get') return { task: { status: 'done' }, attempts: [] };
      if (name === 'tasks.followUp' && sends++ === 0)
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (name === 'tasks.followUp') return { ok: true };
      return true;
    });
    mount();
    fireEvent.click(screen.getByTestId('enqueue'));
    await waitFor(() => expect(fake.inputs('tasks.followUp')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('enqueue'));
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
    await fake.emit('tasks.changed', {});
    expect(fake.inputs('tasks.followUp')).toHaveLength(1);
    finish({ ok: true });
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0'));
    expect(fake.inputs('tasks.followUp')).toHaveLength(2);
  });

  it('continues direct child delivery after the producer is unmounted', async () => {
    let busy = true;
    const fake = installFakeApi((name) => {
      if (name === 'harness.tabs')
        return {
          tabs: [{ id: 'parent', backend: 'codex', status: 'idle', cwd: '/w' }],
          activeTabId: 'main',
          running: 0,
          queued: 0,
        };
      if (name === 'harness.messageAgent')
        return busy ? { ok: false, reason: 'busy' } : { ok: true };
      return [];
    });
    const to: OutboxTarget = {
      kind: 'nested',
      parentTabId: 'parent',
      callId: 'call',
      agentId: 'child',
      name: 'worker',
    };
    const tree = (open: boolean) => (
      <HarnessTabsProvider>
        <SubagentOutboxProvider>{open ? <Producer to={to} /> : null}</SubagentOutboxProvider>
      </HarnessTabsProvider>
    );
    const result = render(tree(true));
    fireEvent.click(screen.getByTestId('enqueue'));
    await waitFor(() => expect(fake.inputs('harness.messageAgent')).toHaveLength(1));
    result.rerender(tree(false));
    busy = false;
    await fake.emit('harness.events', [
      {
        tabId: 'parent',
        type: 'agent',
        op: 'end',
        id: 'child',
        callId: 'call',
        status: 'completed',
      },
    ]);
    await waitFor(() => expect(fake.inputs('harness.messageAgent')).toHaveLength(2));
    expect(fake.inputs('harness.messageAgent')[1]).toMatchObject({
      id: 'parent',
      callId: 'call',
      agentId: 'child',
      text: 'message',
    });
  });
});
