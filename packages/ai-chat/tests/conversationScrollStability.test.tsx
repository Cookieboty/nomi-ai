// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import type { ChatMessage } from '../src/types/chat';
import type { ConvMessage } from '../src/types/conversation';

import { NomiConversation } from './nomiRender';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const chat = (over: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage =>
  ({
    role: 'user',
    content: 'q',
    timestamp: 1,
    ...over,
  }) as ChatMessage;

function makeTurns(count: number, prefix = 'm'): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push(chat({ id: `${prefix}-u${i}`, role: 'user', content: `提问 ${i}` }));
    out.push(chat({ id: `${prefix}-a${i}`, role: 'assistant', content: `回复 ${i}` }));
  }
  return out;
}

function makeConvTurns(count: number, prefix = 'c'): ConvMessage[] {
  const out: ConvMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: `${prefix}-u${i}`, role: 'user', text: `提问 ${i}`, at: i * 2 + 1 });
    out.push({ id: `${prefix}-a${i}`, role: 'assistant', text: `回复 ${i}`, at: i * 2 + 2 });
  }
  return out;
}

describe('会话历史与任务完成滚动稳定性', () => {
  it('完成任务追加巨型轨迹后，已渲染的历史轮次保持单调不收缩（不会被卸载再跳动）', async () => {
    const initial = makeTurns(15, 't');
    const { container, rerender } = render(
      <NomiConversation scopeId="mono-heavy" messages={initial} transcriptView="normal" />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="conv-turn"]')).toHaveLength(15);
    });

    const withHeavyDone: ChatMessage[] = [
      ...initial,
      chat({ id: 't-u15', role: 'user', content: '最后一步' }),
      chat({
        id: 't-a15',
        role: 'assistant',
        content: '完成',
        trace: Array.from({ length: 2000 }, (_, i) => ({
          type: 'tool' as const,
          name: 'read_file',
          status: 'done' as const,
          id: `call-${i}`,
          output: 'ok',
          at: i + 1,
        })),
      }),
    ];

    rerender(
      <NomiConversation scopeId="mono-heavy" messages={withHeavyDone} transcriptView="normal" />,
    );

    const turns = [...container.querySelectorAll('[data-testid="conv-turn"]')];
    expect(turns).toHaveLength(16);
    expect(turns[0]!.getAttribute('data-turn-index')).toBe('0');
  });

  it('首屏分批补齐结束后，连续追加新轮次不再被 INITIAL_RENDER/RENDER_STEP 截断顶部', async () => {
    const initial = makeTurns(10, 's');
    const { container, rerender } = render(
      <NomiConversation scopeId="staged-lock" messages={initial} transcriptView="minimal" />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="conv-turn"]')).toHaveLength(10);
    });

    let current = initial;
    for (let k = 10; k < 14; k++) {
      current = [
        ...current,
        chat({ id: `s-u${k}`, role: 'user', content: `新问题 ${k}` }),
        chat({ id: `s-a${k}`, role: 'assistant', content: `新回答 ${k}` }),
      ];
      rerender(
        <NomiConversation scopeId="staged-lock" messages={current} transcriptView="minimal" />,
      );
    }

    const turns = [...container.querySelectorAll('[data-testid="conv-turn"]')];
    expect(turns).toHaveLength(14);
    expect(turns[0]!.getAttribute('data-turn-index')).toBe('0');
  });

  it('用户上滑阅读历史时，任务完成导致底部高度骤缩不会把视口强行拉回底部', () => {
    const proto = HTMLElement.prototype;
    const savedSh = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    const savedCh = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
    const savedRo = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

    let sh = 1600;
    const ch = 400;
    const observers: Array<() => void> = [];

    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => sh });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => ch });
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      private cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
        observers.push(() => this.cb());
      }
      observe() {}
      disconnect() {}
    };

    try {
      const msgs = makeConvTurns(4, 'shrink');
      const { getByTestId, queryByTestId, rerender } = render(
        <ConversationView
          scopeId="shrink-stay"
          messages={[...msgs, { id: 'shrink-u4', role: 'user', text: '请改代码', at: 9 }]}
          live={{ text: '流式过程内容...', startedAt: 10 }}
          phase="running"
          transcriptView="minimal"
        />,
      );

      const scroller = getByTestId('conv-scroll');
      expect(scroller.scrollTop).toBe(1600);

      // 用户向上滚到离底 100px 处阅读上方历史
      fireEvent.wheel(scroller, { deltaY: -80 });
      scroller.scrollTop = 1100;
      fireEvent.scroll(scroller);
      expect(queryByTestId('conv-jump-bottom')).not.toBeNull();

      // 任务完成瞬间极简收起：高度骤缩至 1220，浏览器被动将 scrollTop clamp 到 820（此时离底 0px）
      sh = 1220;
      scroller.scrollTop = 820;
      fireEvent.scroll(scroller);

      rerender(
        <ConversationView
          scopeId="shrink-stay"
          messages={[...msgs, ...makeConvTurns(1, 'shrink-tail')]}
          live={null}
          phase="idle"
          transcriptView="minimal"
        />,
      );

      // 随后底部卡片异步撑高：由于用户仍在阅读历史，不应触发粘底跳到 1500
      sh = 1500;
      act(() => {
        observers.forEach((fn) => fn());
      });

      expect(scroller.scrollTop).toBe(820);
      expect(queryByTestId('conv-jump-bottom')).not.toBeNull();
    } finally {
      if (savedSh) Object.defineProperty(proto, 'scrollHeight', savedSh);
      else delete (proto as unknown as Record<string, unknown>).scrollHeight;
      if (savedCh) Object.defineProperty(proto, 'clientHeight', savedCh);
      else delete (proto as unknown as Record<string, unknown>).clientHeight;
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = savedRo;
    }
  });

  it('顶部哨兵进入可视区自动加载更早消息，并用锚点轮次位置精准补偿 scrollTop', async () => {
    const proto = HTMLElement.prototype;
    const savedCh = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
    const savedSh = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    const savedRect = proto.getBoundingClientRect;
    const savedIo = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

    const many = makeConvTurns(45, 'top'); // 90 条消息，45 轮；WINDOW_MESSAGES = 30
    let baselineTurnCount = 0;
    let firstTurnIndexObserved: string | null = null;
    const sentinelObservers: Array<{ el: Element; cb: IntersectionObserverCallback }> = [];

    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 2000 });
    proto.getBoundingClientRect = function (this: HTMLElement) {
      if (this.dataset?.testid === 'conv-scroll') {
        return { top: 100, bottom: 500, height: 400, left: 0, right: 600, width: 600 } as DOMRect;
      }
      if (this.dataset?.testid === 'conv-turn') {
        if (firstTurnIndexObserved === null)
          firstTurnIndexObserved = this.dataset.turnIndex ?? null;
        // 一旦上方历史轮次挂载进 DOM（总数 > baselineTurnCount），原锚点轮次向下移 650px
        const currentCount = document.querySelectorAll('[data-testid="conv-turn"]').length;
        const shift = baselineTurnCount > 0 && currentCount > baselineTurnCount ? 650 : 0;
        const baseTop = this.dataset.turnIndex === firstTurnIndexObserved ? 120 : 280;
        const top = baseTop + shift;
        return {
          top,
          bottom: top + 120,
          height: 120,
          left: 0,
          right: 600,
          width: 600,
        } as DOMRect;
      }
      return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 } as DOMRect;
    };

    (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = class MockIO {
      private cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe(el: Element) {
        sentinelObservers.push({ el, cb: this.cb });
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [0];
    };

    try {
      const { container, findByTestId } = render(
        <ConversationView scopeId="top-io" messages={many} phase="idle" transcriptView="minimal" />,
      );

      const loadBtn = await findByTestId('conv-load-earlier');
      const scroller = container.querySelector<HTMLElement>('[data-testid="conv-scroll"]')!;
      const beforeCount = container.querySelectorAll('[data-testid="conv-turn"]').length;
      baselineTurnCount = beforeCount;

      // 用户往上滚（停止贴底）并停在 scrollTop = 500
      fireEvent.wheel(scroller, { deltaY: -100 });
      scroller.scrollTop = 500;
      fireEvent.scroll(scroller);

      const entry = [...sentinelObservers].reverse().find((x) => x.el === loadBtn);
      expect(entry).toBeTruthy();

      await act(async () => {
        entry!.cb(
          [{ isIntersecting: true, target: loadBtn } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });

      await waitFor(() => {
        expect(container.querySelectorAll('[data-testid="conv-turn"]').length).toBeGreaterThan(
          beforeCount,
        );
      });
      // scrollTop 精准加上锚点位移 650px（500 + 650 = 1150）
      expect(scroller.scrollTop).toBe(1150);
    } finally {
      if (savedCh) Object.defineProperty(proto, 'clientHeight', savedCh);
      else delete (proto as unknown as Record<string, unknown>).clientHeight;
      if (savedSh) Object.defineProperty(proto, 'scrollHeight', savedSh);
      else delete (proto as unknown as Record<string, unknown>).scrollHeight;
      proto.getBoundingClientRect = savedRect;
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIo;
    }
  });

  it('ConversationQuickNav 在任务完成更新轮次时不调用原生 element.scrollIntoView', async () => {
    const spy = vi.fn();
    const saved = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = spy;

    try {
      const msgs = makeConvTurns(8, 'qnav');
      const { findByTestId, rerender } = render(
        <ConversationView
          scopeId="qnav-no-native-scroll"
          messages={msgs}
          phase="running"
          transcriptView="minimal"
        />,
      );
      await findByTestId('conversation-quick-nav');
      rerender(
        <ConversationView
          scopeId="qnav-no-native-scroll"
          messages={[...msgs, ...makeConvTurns(1, 'qnav-done')]}
          phase="idle"
          transcriptView="minimal"
        />,
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollIntoView = saved;
    }
  });
});
