// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollapsedRail, RAIL_MAX } from '../src/components/Sidebar/CollapsedRail';
import type { Meta } from '../src/components/Sidebar/types';
import type { HarnessTabMeta } from '../src/services/harnessClient';

afterEach(cleanup);

const meta = (id: string, over: Partial<Meta> = {}): Meta =>
  ({
    id,
    name: `chat ${id}`,
    backend: 'nomi',
    createdAt: 0,
    updatedAt: Date.now(),
    ...over,
  }) as Meta;

describe('CollapsedRail（侧栏收起时的对话方块）', () => {
  it('每个对话一个方块：端点图标、当前对话高亮，点一下切过去', () => {
    const onOpen = vi.fn();
    const r = render(
      <CollapsedRail
        items={[
          meta('a', { name: '修复登录' }),
          meta('b', { name: 'refactor api', backend: 'claude' }),
        ]}
        activeId="b"
        tabById={new Map()}
        onOpen={onOpen}
        onCtx={() => undefined}
        onExpand={() => undefined}
      />,
    );
    const items = r.getAllByTestId('collapsed-rail-item');
    expect(items[0]!.querySelector('[data-testid="endpoint-icon-nomi"]')).toBeTruthy();
    expect(items[1]!.querySelector('[data-testid="endpoint-icon-claude"]')).toBeTruthy();
    expect(items[0]!.getAttribute('aria-label')).toBe('修复登录');
    expect(items[1]!.getAttribute('aria-current')).toBe('page');
    fireEvent.click(items[0]!);
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('悬停 / 聚焦立刻弹出卡片：完整标题 + 端点 · 时间 · 状态；移开就消失', () => {
    const tab = { id: 't1', status: 'running', unread: 0 } as unknown as HarnessTabMeta;
    const r = render(
      <CollapsedRail
        items={[meta('a', { name: '给支付模块补测试', tabId: 't1', backend: 'codex' })]}
        tabById={new Map([['t1', tab]])}
        onOpen={() => undefined}
        onCtx={() => undefined}
        onExpand={() => undefined}
      />,
    );
    const item = r.getByTestId('collapsed-rail-item');
    expect(r.queryByTestId('collapsed-rail-peek')).toBeNull();
    fireEvent.mouseEnter(item);
    const peek = r.getByTestId('collapsed-rail-peek');
    expect(peek.textContent).toContain('给支付模块补测试');
    expect(peek.textContent).toContain('Codex');
    expect(peek.textContent).toContain('进行中');
    fireEvent.mouseLeave(item);
    expect(r.queryByTestId('collapsed-rail-peek')).toBeNull();
    fireEvent.focus(item);
    expect(r.getByTestId('collapsed-rail-peek')).toBeTruthy();
    fireEvent.blur(item);
    expect(r.queryByTestId('collapsed-rail-peek')).toBeNull();
  });

  it('编程助手标签在跑时显示状态点', () => {
    const tab = { id: 't1', status: 'running', unread: 0 } as unknown as HarnessTabMeta;
    const r = render(
      <CollapsedRail
        items={[meta('a', { tabId: 't1', backend: 'codex' })]}
        tabById={new Map([['t1', tab]])}
        onOpen={() => undefined}
        onCtx={() => undefined}
        onExpand={() => undefined}
      />,
    );
    expect(r.container.querySelector('[data-live="running"]')).toBeTruthy();
  });

  it(`超过 ${RAIL_MAX} 个时只列前 ${RAIL_MAX} 个，「+N」展开侧栏；没有对话时不渲染`, () => {
    const onExpand = vi.fn();
    const many = Array.from({ length: RAIL_MAX + 3 }, (_, i) => meta(String(i)));
    const r = render(
      <CollapsedRail
        items={many}
        tabById={new Map()}
        onOpen={() => undefined}
        onCtx={() => undefined}
        onExpand={onExpand}
      />,
    );
    expect(r.getAllByTestId('collapsed-rail-item')).toHaveLength(RAIL_MAX);
    fireEvent.click(r.getByTestId('collapsed-rail-more'));
    expect(onExpand).toHaveBeenCalled();
    expect(r.getByTestId('collapsed-rail-more').textContent).toBe('+3');
    cleanup();
    const empty = render(
      <CollapsedRail
        items={[]}
        tabById={new Map()}
        onOpen={() => undefined}
        onCtx={() => undefined}
        onExpand={() => undefined}
      />,
    );
    expect(empty.queryByTestId('collapsed-rail')).toBeNull();
  });
});
