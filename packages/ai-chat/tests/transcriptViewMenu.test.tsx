// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  type TranscriptView,
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

const mountConversation = (view: TranscriptView) =>
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

describe('Transcript view 的四种显示模式', () => {
  it('极简：隐藏思考、工具与中间过渡文字，只展示总结与顶部可展开步骤', () => {
    const first = '先让我查看一下这两个文件。';
    const richTrace: HarnessTraceEvent[] = [
      { type: 'thinking', text: '先思考一下路径', at: 1000, textAt: 0 },
      {
        type: 'tool',
        name: 'Read',
        id: 'r1',
        status: 'start',
        at: 2000,
        textAt: first.length,
        input: JSON.stringify({ file_path: 'a.ts' }),
      },
      {
        type: 'tool',
        name: 'Read',
        id: 'r1',
        status: 'done',
        at: 5000,
        textAt: first.length,
        output: 'alpha',
      },
    ];
    const r = render(
      <ConversationView
        scopeId="s"
        transcriptView="minimal"
        phase="idle"
        messages={[
          { id: 'u', role: 'user', text: '看看文件', at: 0 },
          {
            id: 'a',
            role: 'assistant',
            text: `${first}\n\n最终结论：两个文件都正常。`,
            textBreaks: [first.length + 2],
            at: 6000,
            durationMs: 12_000,
            trace: richTrace,
          },
        ]}
      />,
    );
    expect(r.queryByTestId('tool-thinking')).toBeNull();
    expect(r.queryByTestId('tool-activity')).toBeNull();
    expect(r.queryByTestId('tool-row')).toBeNull();
    expect(r.container.textContent).not.toContain(first);
    expect(r.container.textContent).toContain('最终结论：两个文件都正常。');

    const steps = r.getByTestId('minimal-steps');
    expect(steps.getAttribute('data-open')).toBe('false');
    expect(r.getByTestId('minimal-steps-toggle').textContent).toContain('已处理 12s · 2 步');

    fireEvent.click(r.getByTestId('minimal-steps-toggle'));
    expect(steps.getAttribute('data-open')).toBe('true');
    expect(r.getByTestId('minimal-step-text').textContent).toContain(first);
    expect(r.getByTestId('tool-thinking').getAttribute('data-open')).toBe('false');
    const row = r.getByTestId('tool-row');
    expect(row.getAttribute('data-open')).toBe('false');
    fireEvent.click(row.querySelector('button')!);
    expect(row.querySelector('[data-testid="tool-output"]')?.textContent).toBe('alpha');
  });

  it('极简运行中：有步骤时隐藏过程文字和工具，可随时点击横条展开并在定稿后保持展开与局部滚动隔离', () => {
    const firstText = '正在准备查看文件';
    const liveTrace: HarnessTraceEvent[] = [
      {
        type: 'tool',
        name: 'Read',
        id: 'r1',
        status: 'start',
        at: 2,
        textAt: firstText.length,
        input: JSON.stringify({ file_path: 'a.ts' }),
      },
      {
        type: 'tool',
        name: 'Read',
        id: 'r2',
        status: 'start',
        at: 3,
        textAt: firstText.length,
        input: JSON.stringify({ file_path: 'b.ts' }),
      },
    ];
    const outerWheelSpy = vi.fn();
    const r = render(
      <div onWheel={outerWheelSpy}>
        <ConversationView
          scopeId="s-live"
          transcriptView="minimal"
          phase="running"
          messages={[{ id: 'u', role: 'user', text: '检查', at: 0 }]}
          live={{
            text: firstText,
            startedAt: Date.now() - 2300,
            firstEventAt: Date.now() - 2000,
            trace: liveTrace,
            permissions: [{ id: 'p1', summary: 'Bash: ls' }],
          }}
          onPermission={() => undefined}
        />
      </div>,
    );
    expect(r.queryByTestId('tool-row')).toBeNull();
    expect(r.queryByTestId('conv-segment')).toBeNull();
    expect(r.getByTestId('conv-status-step').textContent).toBe('第 2 步');
    expect(r.getByTestId('conv-status-time').textContent).toMatch(/^\d+(?:\.\d+)?s$/);
    expect(r.getByTestId('conv-permission-card')).toBeTruthy();

    // 运行中点击折叠横条展开：实时渲染过程文字与逐行步骤（不二次合并）
    const steps = r.getByTestId('minimal-steps');
    expect(steps.getAttribute('data-open')).toBe('false');
    fireEvent.click(r.getByTestId('minimal-steps-toggle'));
    expect(steps.getAttribute('data-open')).toBe('true');
    const body = r.getByTestId('minimal-steps-body');
    expect(r.getByTestId('minimal-step-text').textContent).toContain(firstText);
    expect(r.queryByTestId('tool-group')).toBeNull();
    expect(r.getAllByTestId('tool-row')).toHaveLength(2);

    // 局部区域可独立滚动：未溢出时滚轮正常外传；内容溢出时停止向上层对话组件冒泡
    Object.defineProperty(body, 'scrollHeight', { value: 240, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 240, configurable: true });
    fireEvent.wheel(body, { deltaY: -40 });
    expect(outerWheelSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(body, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(body, 'clientHeight', { value: 320, configurable: true });
    fireEvent.wheel(body, { deltaY: -40 });
    expect(outerWheelSpy).toHaveBeenCalledTimes(1);

    // 运行结束定稿：保留用户在运行中打开的展开状态不闪关，下方展示最终总结
    const summaryText = '最终总结：两个文件检查通过。';
    r.rerender(
      <div onWheel={outerWheelSpy}>
        <ConversationView
          scopeId="s-live"
          transcriptView="minimal"
          phase="idle"
          messages={[
            { id: 'u', role: 'user', text: '检查', at: 0 },
            {
              id: 'a1',
              role: 'assistant',
              text: `${firstText}\n\n${summaryText}`,
              textBreaks: [firstText.length + 2],
              at: 6000,
              durationMs: 4200,
              trace: [
                ...liveTrace,
                {
                  type: 'tool',
                  name: 'Read',
                  id: 'r1',
                  status: 'done',
                  at: 4,
                  textAt: firstText.length,
                  output: 'a',
                },
                {
                  type: 'tool',
                  name: 'Read',
                  id: 'r2',
                  status: 'done',
                  at: 5,
                  textAt: firstText.length,
                  output: 'b',
                },
              ],
            },
          ]}
        />
      </div>,
    );
    expect(r.getByTestId('minimal-steps').getAttribute('data-open')).toBe('true');
    expect(r.getByTestId('minimal-steps-body')).toBeTruthy();
    expect(r.getByTestId('conv-segment').textContent).toContain(summaryText);

    // 纯文本无步骤问答：照常流式展示正文
    r.rerender(
      <ConversationView
        scopeId="s-plain"
        transcriptView="minimal"
        phase="running"
        messages={[{ id: 'u', role: 'user', text: '你好', at: 0 }]}
        live={{
          text: '你好，我在！',
          startedAt: Date.now(),
          firstEventAt: Date.now(),
        }}
      />,
    );
    expect(r.queryByTestId('conv-status-step')).toBeNull();
    expect(r.getByTestId('conv-segment').textContent).toContain('你好，我在！');
    expect(r.getByTestId('conv-status-time').textContent).toBe('0s');
  });

  it('极简中途插话：运行中与完成后均以「你插入了」分段展现新的 AI 返回状态、折叠步骤与正文', () => {
    const preText = '正在读取现有文件。';
    const postIntro = '收到，我按新要求继续执行。';
    const finalSummary = '针对插话已经完成核对。';
    const now = Date.now();
    const baseTrace: HarnessTraceEvent[] = [
      {
        type: 'tool',
        name: 'Read',
        id: 'r1',
        status: 'start',
        at: now - 8000,
        textAt: preText.length,
        input: JSON.stringify({ file_path: 'a.ts' }),
      },
      {
        type: 'tool',
        name: 'Read',
        id: 'r1',
        status: 'done',
        at: now - 5000,
        textAt: preText.length,
        output: 'alpha',
      },
      {
        type: 'interject',
        text: '我目前把所有的 agent 都改成了 agent，这符合要求吗？',
        at: now - 2000,
        textAt: preText.length,
      },
    ];

    // 1. 运行中刚插话（尚无新步骤）：前置步骤锁定在上方，你插入了正下方立即显示实时状态
    const r = render(
      <ConversationView
        scopeId="s-interject"
        transcriptView="minimal"
        phase="running"
        messages={[{ id: 'u', role: 'user', text: '改一下措辞', at: 0 }]}
        live={{
          text: preText,
          startedAt: now - 9000,
          firstEventAt: now - 8500,
          trace: baseTrace,
        }}
      />,
    );

    const stepsAfterInterject = r.getAllByTestId('minimal-steps');
    expect(stepsAfterInterject).toHaveLength(1);
    expect(stepsAfterInterject[0]!.getAttribute('data-open')).toBe('false');
    expect(stepsAfterInterject[0]!.textContent).toContain('1 步');
    expect(stepsAfterInterject[0]!.querySelector('[data-testid="conv-status"]')).toBeNull();

    const interjectEl = r.getByTestId('trace-interject');
    const statusEl = r.getByTestId('conv-status');
    // 实时状态行必须排在「你插入了」气泡之后，且不会误显示插话前正文触发的 writing
    expect(
      Boolean(interjectEl.compareDocumentPosition(statusEl) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(statusEl.getAttribute('data-kind')).toBe('working');

    // 2. 运行中插话后产生了新的工具步骤：在「你插入了」下方出现第二个实时 MinimalSteps，且点击展开在定稿时保留
    const postTrace: HarnessTraceEvent[] = [
      ...baseTrace,
      {
        type: 'tool',
        name: 'Bash',
        id: 'b1',
        status: 'start',
        at: now - 1000,
        textAt: preText.length + 2 + postIntro.length,
        input: JSON.stringify({ command: 'pnpm test' }),
      },
    ];
    r.rerender(
      <ConversationView
        scopeId="s-interject"
        transcriptView="minimal"
        phase="running"
        messages={[{ id: 'u', role: 'user', text: '改一下措辞', at: 0 }]}
        live={{
          text: `${preText}\n\n${postIntro}`,
          textBreaks: [preText.length + 2],
          startedAt: now - 9000,
          firstEventAt: now - 8500,
          trace: postTrace,
        }}
      />,
    );

    const liveTwoSteps = r.getAllByTestId('minimal-steps');
    expect(liveTwoSteps).toHaveLength(2);
    expect(
      Boolean(
        interjectEl.compareDocumentPosition(liveTwoSteps[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(liveTwoSteps[1]!.querySelector('[data-testid="conv-status-step"]')?.textContent).toBe(
      '第 1 步',
    );
    fireEvent.click(liveTwoSteps[1]!.querySelector('[data-testid="minimal-steps-toggle"]')!);
    expect(liveTwoSteps[1]!.getAttribute('data-open')).toBe('true');

    // 3. 定稿完成：前后各自独立折叠步骤 + 独立保留展开状态，并在新阶段下方展示新 AI 回复正文
    const b1 = preText.length + 2;
    const b2 = b1 + postIntro.length + 2;
    r.rerender(
      <ConversationView
        scopeId="s-interject"
        transcriptView="minimal"
        phase="idle"
        messages={[
          { id: 'u', role: 'user', text: '改一下措辞', at: 0 },
          {
            id: 'a1',
            role: 'assistant',
            text: `${preText}\n\n${postIntro}\n\n${finalSummary}`,
            textBreaks: [b1, b2],
            at: now,
            durationMs: 9000,
            trace: [
              ...postTrace,
              {
                type: 'tool',
                name: 'Bash',
                id: 'b1',
                status: 'done',
                at: now - 200,
                textAt: b1 + postIntro.length,
                output: 'ok',
              },
            ],
          },
        ]}
      />,
    );

    const doneSteps = r.getAllByTestId('minimal-steps');
    expect(doneSteps).toHaveLength(2);
    expect(doneSteps[0]!.getAttribute('data-open')).toBe('false');
    expect(doneSteps[0]!.textContent).toContain('3s · 1 步');
    expect(doneSteps[1]!.getAttribute('data-open')).toBe('true');
    expect(doneSteps[1]!.textContent).toContain('1 步');
    const segs = r.getAllByTestId('conv-segment');
    expect(segs).toHaveLength(1);
    expect(segs[0]!.textContent).toContain(finalSummary);
    expect(
      r.getByTestId('trace-interject').compareDocumentPosition(segs[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // 4. 若插话后无工具直接纯文本回答，新回复正文直接跟在「你插入了」下方外显
    r.rerender(
      <ConversationView
        scopeId="s-interject-text"
        transcriptView="minimal"
        phase="idle"
        messages={[
          { id: 'u', role: 'user', text: '改一下措辞', at: 0 },
          {
            id: 'a2',
            role: 'assistant',
            text: `${preText}\n\n${finalSummary}`,
            textBreaks: [b1],
            at: now,
            durationMs: 4000,
            trace: baseTrace,
          },
        ]}
      />,
    );
    expect(r.getAllByTestId('minimal-steps')).toHaveLength(1);
    const directReply = r.getByTestId('conv-segment');
    expect(directReply.textContent).toContain(finalSummary);
    expect(
      Boolean(
        r.getByTestId('trace-interject').compareDocumentPosition(directReply) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

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

describe('思考的一句话标题', () => {
  it('折叠时显示这段思考的第一句', () => {
    const r = mountConversation('thinking');
    const think = r.getByTestId('tool-thinking');
    expect(think.getAttribute('data-open')).toBe('false');
    expect(r.getByTestId('tool-thinking-title').textContent).toBe('先看一下文件');
  });

  it('展开时标题不带那一句（正文就在下面），收起后再显示', () => {
    const r = mountConversation('thinking');
    const think = r.getByTestId('tool-thinking');
    fireEvent.click(think.querySelector('button')!);
    expect(think.getAttribute('data-open')).toBe('true');
    expect(r.queryByTestId('tool-thinking-title')).toBeNull();
    fireEvent.click(think.querySelector('button')!);
    expect(r.getByTestId('tool-thinking-title').textContent).toBe('先看一下文件');
  });
});

describe('Transcript view 菜单的焦点', () => {
  it('鼠标点选后不把焦点还给按钮（不出现焦点框）；没有悬停提示', () => {
    const r = render(<TranscriptViewButton sessionKey="tab:f" />);
    const btn = r.getByTestId('titlebar-transcript-view');
    expect(btn.getAttribute('title')).toBeNull();
    fireEvent.click(btn);
    fireEvent.click(screen.getByTestId('transcript-view-verbose'), { detail: 1 });
    expect(document.activeElement).not.toBe(btn);
    expect(getTranscriptView('tab:f')).toBe('verbose');
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
    // tab:b 没有单独设置：显示全局默认（初始「极简」）
    expect(screen.getByTestId('transcript-view-minimal').getAttribute('aria-checked')).toBe('true');
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
