// @vitest-environment happy-dom
/** 素材库（主区整页）：列出生成的图片、按来源筛选、右侧看大图与提示词、删除（先确认）、在文件夹中显示 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssetLibraryNav, AssetLibraryPage } from '../src/components/AssetLibrary';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

const items = [
  {
    file: 'nomi-b.png',
    url: 'chat-asset://images/nomi-b.png',
    source: 'nomi',
    createdAt: 1_700_000_100_000,
    bytes: 10,
    model: 'amux/openai/gpt-image-2',
    prompt: 'a red fox',
    aspect: '3:2',
    editedFrom: 'grok-a.png',
    category: 'animal',
    tags: ['狐狸'],
    width: 1536,
    height: 1024,
  },
  {
    file: 'grok-a.png',
    url: 'chat-asset://images/grok-a.png',
    source: 'grok',
    createdAt: 1_700_000_000_000,
    bytes: 10,
    category: 'other',
    tags: [],
  },
];

let fake: FakeApi;
let list = items;
beforeEach(() => {
  list = items;
  fake = installFakeApi({
    'chatAssets.list': () => list,
    'chatAssets.remove': ({ files }: { files: string[] }) => {
      list = list.filter((x) => !files.includes(x.file));
      return { removed: files };
    },
    'chatAssets.reveal': () => true,
    'chatAssets.update': (patch: { file: string; category?: string; tags?: string[] }) => {
      list = list.map((x) => (x.file === patch.file ? { ...x, ...patch } : x));
      return list.find((x) => x.file === patch.file);
    },
    'chatAssets.saveAs': () => true,
    'chatAssets.regenerate': () => ({
      file: 'nomi-c.png',
      url: 'chat-asset://images/nomi-c.png',
      source: 'nomi',
      createdAt: 1_700_000_200_000,
      bytes: 10,
      model: 'amux/openai/gpt-image-2',
      prompt: 'a red fox again',
    }),
  });
});
afterEach(() => {
  cleanup();
  resetFakeApi();
});

const onBack = vi.fn();
async function open() {
  render(<AssetLibraryPage active onBack={onBack} />);
  await act(() => fake.settle());
}

describe('素材库', () => {
  it('列出全部生成的图片，标出来源与分类（在图片里）；按来源、分类、搜索筛选；已用空间', async () => {
    await open();
    expect(screen.getByTestId('asset-nomi-b.png')).toBeTruthy();
    expect(screen.getByTestId('asset-grok-a.png').textContent).toContain('Grok');
    expect(screen.getByTestId('asset-nomi-b.png').textContent).toContain('动物');
    // 分类标签上的数字是真实条数
    expect(screen.getByTestId('asset-category-all').textContent).toContain('2');
    expect(screen.getByTestId('asset-category-animal').textContent).toContain('1');
    expect(screen.getByTestId('asset-category-people').textContent).toContain('0');
    fireEvent.click(screen.getByTestId('asset-category-animal'));
    expect(screen.queryByTestId('asset-grok-a.png')).toBeNull();
    fireEvent.click(screen.getByTestId('asset-category-all'));
    fireEvent.change(screen.getByTestId('asset-source-filter'), { target: { value: 'grok' } });
    expect(screen.queryByTestId('asset-nomi-b.png')).toBeNull();
    fireEvent.change(screen.getByTestId('asset-source-filter'), { target: { value: 'all' } });
    // 搜索提示词与标签
    fireEvent.change(screen.getByTestId('asset-search'), { target: { value: '狐狸' } });
    expect(screen.queryByTestId('asset-grok-a.png')).toBeNull();
    expect(screen.getByTestId('asset-nomi-b.png')).toBeTruthy();
    expect(screen.getByTestId('asset-usage').textContent).toContain('20 B');
  });

  it('查看器：左右切换；改分类、加标签都交给内核；相关推荐的「查看更多」按分类筛选', async () => {
    list = [
      items[0]!,
      { ...items[0]!, file: 'nomi-d.png', url: 'chat-asset://images/nomi-d.png', tags: [] },
      items[1]!,
    ];
    await open();
    fireEvent.click(screen.getByTestId('asset-nomi-b.png'));
    // 同一分类（动物）的相关推荐；「查看更多」回到素材库按这个分类筛选
    expect(screen.getByTestId('viewer-related')).toBeTruthy();
    fireEvent.click(screen.getByTestId('viewer-related-more'));
    expect(screen.queryByTestId('image-viewer')).toBeNull();
    expect(screen.getByTestId('asset-category-animal').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('asset-category-all'));
    fireEvent.click(screen.getByTestId('asset-nomi-b.png'));
    expect(screen.getByTestId('viewer-resolution').textContent).toContain('1536 × 1024');
    fireEvent.click(screen.getByTestId('viewer-next'));
    expect(screen.getByTestId('viewer-prompt').textContent).toBe('a red fox');
    expect(screen.getByTestId('viewer-strip')).toBeTruthy();
    fireEvent.change(screen.getByTestId('viewer-category'), { target: { value: 'people' } });
    await act(() => fake.settle());
    expect(fake.inputs('chatAssets.update').at(-1)).toMatchObject({ category: 'people' });
    fireEvent.click(screen.getByTestId('viewer-tag-add'));
    const input = screen.getByTestId('viewer-tag-input');
    fireEvent.change(input, { target: { value: '红色' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(() => fake.settle());
    expect(fake.inputs('chatAssets.update').at(-1)).toMatchObject({ tags: ['红色'] });
    fireEvent.click(screen.getByTestId('viewer-prev'));
    expect(screen.getByTestId('viewer-prompt').textContent).toBe('a red fox');
  });

  it('侧栏入口：醒目的一行，带数量；打开时标为当前页', () => {
    const onOpen = vi.fn();
    const r = render(<AssetLibraryNav collapsed={false} active count={2} onOpen={onOpen} />);
    const nav = r.getByTestId('asset-library-open');
    expect(nav.textContent).toContain('素材库');
    expect(nav.textContent).toContain('2');
    expect(nav.getAttribute('aria-current')).toBe('page');
    fireEvent.click(nav);
    expect(onOpen).toHaveBeenCalled();
  });

  it('没有单独的返回按钮（导航栏「对话」回去）；Esc 回对话', async () => {
    await open();
    expect(screen.queryByTestId('asset-back')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBack).toHaveBeenCalled();
  });

  it('点一张图打开查看器：提示词、模型、画幅、改图来源；在文件夹中显示；删除先确认', async () => {
    await open();
    fireEvent.click(screen.getByTestId('asset-nomi-b.png'));
    const viewer = screen.getByTestId('image-viewer');
    expect(screen.getByTestId('viewer-prompt').textContent).toBe('a red fox');
    expect(screen.getByTestId('viewer-details').textContent).toContain('amux/openai/gpt-image-2');
    expect(screen.getByTestId('viewer-details').textContent).toContain('3:2');
    expect(screen.getByTestId('viewer-edited-from')).toBeTruthy();
    expect(viewer).toBeTruthy();
    fireEvent.click(screen.getByTestId('viewer-more'));
    fireEvent.click(screen.getByTestId('asset-reveal'));
    await act(() => fake.settle());
    expect(fake.inputs('chatAssets.reveal')).toEqual([{ file: 'nomi-b.png' }]);
    (window as unknown as { confirm: unknown }).confirm = vi.fn(() => true);
    fireEvent.click(screen.getByTestId('viewer-more'));
    fireEvent.click(screen.getByTestId('asset-delete'));
    await waitFor(() =>
      expect(fake.inputs('chatAssets.remove')).toEqual([{ files: ['nomi-b.png'] }]),
    );
    await waitFor(() => expect(screen.queryByTestId('asset-nomi-b.png')).toBeNull());
  });

  it('重新生成：换成新图；下载走另存为；以此修改 / 作为参考把带链接的一句话交给对话', async () => {
    const onCompose = vi.fn();
    render(<AssetLibraryPage active onBack={onBack} onCompose={onCompose} />);
    await act(() => fake.settle());
    fireEvent.click(screen.getByTestId('asset-nomi-b.png'));
    // 重新生成会再调一次付费接口：先确认，取消就不生成
    const confirm = vi.fn(() => false);
    (window as unknown as { confirm: unknown }).confirm = confirm;
    fireEvent.click(screen.getByTestId('viewer-regenerate'));
    await act(() => fake.settle());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fake.inputs('chatAssets.regenerate')).toEqual([]);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('viewer-regenerate'));
    await waitFor(() =>
      expect(fake.inputs('chatAssets.regenerate')).toEqual([{ file: 'nomi-b.png' }]),
    );
    await waitFor(() =>
      expect(screen.getByTestId('viewer-prompt').textContent).toBe('a red fox again'),
    );
    fireEvent.click(screen.getByTestId('viewer-more'));
    fireEvent.click(screen.getByTestId('viewer-download'));
    await act(() => fake.settle());
    expect(fake.inputs('chatAssets.saveAs')).toEqual([{ file: 'nomi-c.png' }]);
    fireEvent.click(screen.getByTestId('viewer-edit'));
    expect(onCompose).toHaveBeenCalledWith(
      expect.stringContaining('chat-asset://images/nomi-c.png'),
    );
    expect(screen.queryByTestId('image-viewer')).toBeNull();
    fireEvent.click(screen.getByTestId('asset-nomi-b.png'));
    fireEvent.click(screen.getByTestId('viewer-reference'));
    expect(onCompose).toHaveBeenLastCalledWith(expect.stringContaining('参考这张图片'));
  });

  it('编程助手生成的图片（没有提示词）：不能重新生成', async () => {
    await open();
    fireEvent.click(screen.getByTestId('asset-grok-a.png'));
    expect(screen.queryByTestId('viewer-regenerate')).toBeNull();
    expect(screen.getByTestId('viewer-prompt').textContent).toContain('没有记下提示词');
  });

  it('生成新图片后跟着刷新；没有图片时给出说明', async () => {
    list = [];
    await open();
    expect(screen.getByTestId('asset-empty')).toBeTruthy();
    list = items;
    await act(() => fake.emit('chatAssets.changed', null));
    await act(() => fake.settle());
    expect(screen.getByTestId('asset-nomi-b.png')).toBeTruthy();
  });
});
