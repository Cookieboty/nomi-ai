// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import { TranscriptViewSettings } from '../src/components/SettingsView/TranscriptViewSettings';
import { TranscriptViewButton } from '../src/components/TranscriptViewMenu';
import type { HarnessTraceEvent } from '../src/services/harnessClient';
import {
  getGlobalTranscriptView,
  getTranscriptView,
  resetTranscriptViewsForTest,
  setGlobalTranscriptView,
  setTranscriptView,
} from '../src/services/transcriptView';

beforeEach(() => resetTranscriptViewsForTest());
afterEach(cleanup);

const trace: HarnessTraceEvent[] = [
  { type: 'thinking', text: '先看一下文件', at: 1, textAt: 0 },
  {
    type: 'tool',
    name: 'Read',
    id: 'r1',
    status: 'start',
    at: 2,
    textAt: 0,
    input: JSON.stringify({ file_path: 'a.ts' }),
  },
  { type: 'tool', name: 'Read', id: 'r1', status: 'done', at: 3, textAt: 0, output: 'alpha' },
  {
    type: 'tool',
    name: 'Read',
    id: 'r2',
    status: 'start',
    at: 4,
    textAt: 0,
    input: JSON.stringify({ file_path: 'b.ts' }),
  },
  { type: 'tool', name: 'Read', id: 'r2', status: 'done', at: 5, textAt: 0, output: 'beta' },
];

const mountConversation = (view: 'normal' | 'thinking' | 'verbose') =>
  render(
    <ConversationView
      scopeId="s"
      transcriptView={view}
      phase="idle"
      messages={[
        { id: 'u', role: 'user', text: '看看文件', at: 0 },
        { id: 'a', role: 'assistant', text: '好了', at: 6, trace },
      ]}
    />,
  );

describe('Transcript view 的三种显示模式', () => {
  it('精简：同类工具调用合成一行摘要，思考不单独显示', () => {
    const r = mountConversation('normal');
    expect(r.queryByTestId('tool-thinking')).toBeNull();
    const act = r.getByTestId('tool-activity');
    expect(act.getAttribute('data-bucket')).toBe('explore');
    expect(act.getAttribute('data-count')).toBe('2');
    expect(act.getAttribute('data-open')).toBe('false');
  });

  it('显示思考：思考单独显示（完成后折叠），工具照样合成一行', () => {
    const r = mountConversation('thinking');
    expect(r.getByTestId('tool-thinking').getAttribute('data-open')).toBe('false');
    expect(r.getByTestId('tool-activity').getAttribute('data-count')).toBe('2');
  });

  it('Verbose 展开思考、每次工具调用单独成行并默认展开', () => {
    const r = mountConversation('verbose');
    expect(r.getByTestId('tool-thinking').getAttribute('data-open')).toBe('true');
    expect(r.queryAllByTestId('tool-group')).toHaveLength(0);
    expect(r.queryAllByTestId('tool-activity')).toHaveLength(0);
    const rows = r.getAllByTestId('tool-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.getAttribute('data-open')).toBe('true');
    expect(r.getByText('alpha')).toBeTruthy();
    expect(r.getByText('beta')).toBeTruthy();
  });
});

describe('Transcript view 菜单按会话生效', () => {
  it('选择一个模式只写入当前会话；「跟随全局」可以清除覆盖', () => {
    setGlobalTranscriptView('thinking');
    const r = render(<TranscriptViewButton sessionKey="tab:a" />);
    fireEvent.click(r.getByTestId('titlebar-transcript-view'));
    expect(screen.getByTestId('transcript-view-thinking').getAttribute('aria-checked')).toBe(
      'true',
    );

    fireEvent.click(screen.getByTestId('transcript-view-verbose'));
    expect(getTranscriptView('tab:a')).toBe('verbose');
    expect(getTranscriptView('tab:b')).toBe('thinking');

    fireEvent.click(screen.getByTestId('titlebar-transcript-view'));
    fireEvent.click(screen.getByTestId('transcript-view-global'));
    expect(getTranscriptView('tab:a')).toBe('thinking');
    expect(getGlobalTranscriptView()).toBe('thinking');
  });

  it('切换会话后菜单显示那个会话自己的状态', () => {
    setTranscriptView('tab:a', 'verbose');
    const r = render(<TranscriptViewButton sessionKey="tab:a" />);
    expect(r.getByTestId('titlebar-transcript-view').getAttribute('data-override')).toBe('true');

    r.rerender(<TranscriptViewButton sessionKey="tab:b" />);
    expect(r.getByTestId('titlebar-transcript-view').getAttribute('data-override')).toBeNull();
    fireEvent.click(r.getByTestId('titlebar-transcript-view'));
    // tab:b 没有单独设置：显示全局默认（初始「显示思考」）
    expect(screen.getByTestId('transcript-view-thinking').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByTestId('transcript-view-normal').getAttribute('aria-checked')).toBe('false');
  });

  it('设置页只改全局默认；已有会话覆盖继续优先', () => {
    setTranscriptView('tab:a', 'verbose');
    const r = render(<TranscriptViewSettings />);
    fireEvent.change(r.getByTestId('transcript-view-default'), {
      target: { value: 'thinking' },
    });
    expect(getGlobalTranscriptView()).toBe('thinking');
    expect(getTranscriptView('tab:a')).toBe('verbose');
    expect(getTranscriptView('tab:b')).toBe('thinking');
  });
});
