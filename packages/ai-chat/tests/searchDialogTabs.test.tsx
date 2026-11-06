// @vitest-environment happy-dom
/** 搜索窗底部标签：全部 / 对话 / 任务 / 素材库；任务与素材可以搜，点开交给对应页面 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchDialog } from '../src/components/Sidebar/SearchDialog';

vi.mock('../src/components/Tasks', () => ({
  useTasks: () => ({
    data: {
      tasks: [
        { id: 't1', title: '监控 Nomi 新 Issue', goal: '仓库有新 Issue 时提醒', updatedAt: 2 },
        { id: 't2', title: '每周整理周报', goal: '', updatedAt: 1 },
      ],
      legacy: [],
    },
  }),
}));
vi.mock('../src/components/AssetLibrary', () => ({
  useAssets: () => ({
    items: [
      { file: 'a.png', url: 'x', source: 'nomi', createdAt: 1, bytes: 1, prompt: '海边的女孩' },
    ],
  }),
}));

afterEach(cleanup);

const mount = (query = '', extra: Partial<React.ComponentProps<typeof SearchDialog>> = {}) => {
  const onOpenTask = vi.fn();
  const onOpenAsset = vi.fn();
  const onClose = vi.fn();
  render(
    <SearchDialog
      query={query}
      onQuery={() => undefined}
      inputRef={createRef()}
      onKeyDown={() => undefined}
      onClose={onClose}
      searching={!!query}
      shown={[]}
      total={0}
      max={50}
      activeIdx={0}
      onActive={() => undefined}
      indexing={false}
      canSearchMore={false}
      onSearchMore={() => undefined}
      openingKey={null}
      tabById={new Map()}
      onOpenConv={() => undefined}
      onOpenHist={() => undefined}
      onCtx={() => undefined}
      recent={[]}
      newLabel="新对话"
      newHint="⌘N"
      onNew={() => undefined}
      onOpenTask={onOpenTask}
      onOpenAsset={onOpenAsset}
      {...extra}
    />,
  );
  return { onOpenTask, onOpenAsset, onClose };
};

describe('搜索窗标签', () => {
  it('底部有全部 / 对话 / 任务 / 素材库；「全部」没输入时只有快捷操作与最近对话', () => {
    mount();
    expect(screen.getAllByRole('tab').map((x) => x.textContent)).toEqual([
      '全部',
      '对话',
      '任务',
      '素材库',
    ]);
    expect(screen.getByTestId('search-tab-all').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('search-new-chat')).toBeTruthy();
    expect(screen.queryByTestId('search-task')).toBeNull();
  });

  it('「任务」标签列出任务，点开交给任务页并关掉搜索窗', () => {
    const { onOpenTask, onClose } = mount();
    fireEvent.click(screen.getByTestId('search-tab-tasks'));
    expect(screen.getAllByTestId('search-task')).toHaveLength(2);
    expect(screen.queryByTestId('search-new-chat')).toBeNull();
    fireEvent.click(screen.getAllByTestId('search-task')[0]!);
    expect(onClose).toHaveBeenCalled();
    expect(onOpenTask).toHaveBeenCalledWith('t1');
  });

  it('有输入时「全部」里也有匹配的任务与素材', () => {
    const { onOpenAsset } = mount('海边');
    expect(screen.queryByTestId('search-task')).toBeNull();
    fireEvent.click(screen.getByTestId('search-asset'));
    expect(onOpenAsset).toHaveBeenCalledWith('a.png');
  });

  it('没有任务 / 素材入口时不显示这两个标签', () => {
    mount('', { onOpenTask: undefined, onOpenAsset: undefined });
    expect(screen.getAllByRole('tab').map((x) => x.textContent)).toEqual(['全部', '对话']);
  });
});
