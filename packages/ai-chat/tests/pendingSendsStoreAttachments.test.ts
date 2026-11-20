/**
 * #395 / #406：
 * - 带图待发消息在内存中保存图片，写盘（localStorage / 会话元信息）时不存图片本体并立刻标记「附件缺失」，
 *   避免运行中途重启后把残缺话语当原消息自动发出；
 * - 仅贴图未写文字入队时落盘正文为空并标记 imageOnly + attachmentsMissing，多条纯图恢复不误去重；
 * - 用户选择「仅发文字」清掉内存里的 attachmentsMissing 后，落盘同步清除，不从 old 复活；
 * - CLI 标签组绑定会话身份，跨目录 / 换后端 / 重置 CLI 会话时自动隔离旧列表，队列清空时清掉 groupKey。
 */
import { describe, expect, it } from 'vitest';

import {
  PENDING_GROUP_PREFIX,
  mergeRestoredPending,
  openPendingSends,
  pendingKey,
  readStoredPendingSends,
  storedPendingSends,
  type Kv,
  type PendingTabIdentity,
  type StoredPendingSend,
} from '../src/services/pendingSendsStore';
import type { PendingSend } from '../src/utils/pendingSends';

const img = (data: string) => ({ mime: 'image/png', data, width: 4, height: 4, source: 'paste' });

/** 落盘恢复后只剩正文与缺失标记的那条 */
const onlyTextMissing = (id: string, text: string): PendingSend => ({
  id,
  text,
  mode: 'queue',
  attachmentsMissing: true,
});

function memoryKv(): Kv & { rawKeys(): string[] } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
    rawKeys: () => [...m.keys()],
  };
}

describe('storedPendingSends 保留与清除「附件缺失」(#395)', () => {
  it('任何带图消息写盘即标 attachmentsMissing（即使还没发生过发送失败）', () => {
    const out = storedPendingSends([
      { id: 'p1', text: '带图看下', mode: 'queue', images: [img('QUJD')] },
      { id: 'p2', text: '纯文字', mode: 'queue' },
    ]);
    expect(out).toEqual([
      { id: 'p1', text: '带图看下', mode: 'queue', attachmentsMissing: true },
      { id: 'p2', text: '纯文字', mode: 'queue' },
    ]);
  });

  it('仅贴图未写正文：落盘写入空正文 + imageOnly + attachmentsMissing，多条纯图恢复不误合并', () => {
    const out = storedPendingSends([
      {
        id: 'p1',
        text: '请看看这张图片。',
        mode: 'queue',
        images: [img('QUJD')],
        imageOnly: true,
      },
      {
        id: 'p2',
        text: '请看看这张图片。',
        mode: 'queue',
        images: [img('REVG')],
        imageOnly: true,
      },
    ]);
    expect(out).toEqual([
      { id: 'p1', text: '', mode: 'queue', attachmentsMissing: true, imageOnly: true },
      { id: 'p2', text: '', mode: 'queue', attachmentsMissing: true, imageOnly: true },
    ]);
    const read = readStoredPendingSends(out);
    expect(read).toHaveLength(2);
    const { items } = mergeRestoredPending([], read);
    expect(items).toEqual([
      { id: 'p1', text: '', mode: 'queue', attachmentsMissing: true, imageOnly: true },
      { id: 'p2', text: '', mode: 'queue', attachmentsMissing: true, imageOnly: true },
    ]);
  });

  it('从带标记的 raw 读回并转为纯文本仅发文字后：清掉 attachmentsMissing 不被 old 复活', () => {
    const raw = [
      { id: 'p1', text: '第一条', mode: 'queue' as const, attachmentsMissing: true as const },
      { id: 'p2', text: '第二条', mode: 'queue' as const },
    ];
    const read = readStoredPendingSends(raw);
    expect(read.map((s) => s.attachmentsMissing)).toEqual([true, undefined]);
    const stillMissing = storedPendingSends([onlyTextMissing('p1', '第一条')], read);
    expect(stillMissing).toEqual([
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
    ]);
    // 用户点击「仅发文字」后清除了条目上的 attachmentsMissing
    const cleared = storedPendingSends([{ id: 'p1', text: '第一条', mode: 'queue' }], read);
    expect(cleared).toEqual([{ id: 'p1', text: '第一条', mode: 'queue' }]);
  });
});

describe('openPendingSends：重启恢复与 CLI 标签会话身份隔离 (#395, #406)', () => {
  it('带图消息正常入队后未发送即重启：读回带 attachmentsMissing', async () => {
    const kv = memoryKv();
    const key = pendingKey('tab', 't1');
    const a = openPendingSends({ kv }, key);
    a.save(key, [{ id: 'p1', text: '第一条', mode: 'queue', images: [img('QUJD')] }]);
    await a.persist('update');
    expect(a.read()).toEqual([
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
    ]);

    const b = openPendingSends({ kv }, key);
    expect(b.read()).toEqual([
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
    ]);
    b.save(key, [{ id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true }]);
    await b.persist('update');
    expect(b.read()).toEqual([
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
    ]);
  });

  it('空队列打开不写入无用 groupKey；队列清空时同时移除 key 与 groupKey', async () => {
    const kv = memoryKv();
    const key = pendingKey('tab', 't-empty');
    const id: PendingTabIdentity = { tabId: 't-empty', backend: 'claude', cwd: '/w', createdAt: 1 };
    const store = openPendingSends({ kv }, key, { tabIdentity: id });
    expect(kv.rawKeys()).toEqual([]);

    store.save(key, [{ id: 'p1', text: '你好', mode: 'queue' }]);
    await store.persist('update');
    expect(kv.getItem(key)).toBeTruthy();
    expect(kv.getItem(`${PENDING_GROUP_PREFIX}${key}`)).toBeTruthy();

    store.save(key, []);
    await store.persist('update', []);
    expect(kv.rawKeys()).toEqual([]);
  });

  it('同 tabId 切换工作目录 / 后端 / 重置 cliSessionId 时隔离并清理旧会话待发队列', async () => {
    const kv = memoryKv();
    const key = pendingKey('tab', 't-reuse');
    const id1: PendingTabIdentity = {
      tabId: 't-reuse',
      backend: 'claude',
      cwd: '/repo-a',
      cliSessionId: 'sess-1',
      createdAt: 100,
    };
    const s1 = openPendingSends({ kv }, key, { tabIdentity: id1 });
    s1.save(key, [{ id: 'p1', text: '旧会话消息', mode: 'queue' }]);
    await s1.persist('update');

    // 同会话恢复应当保留
    const same = openPendingSends({ kv }, key, { tabIdentity: { ...id1 } });
    expect(same.read().map((x) => x.text)).toEqual(['旧会话消息']);

    // /new 或新项目复用了同 tabId 但身份改变：直接丢弃旧队列并清存储
    const s2 = openPendingSends({ kv }, key, {
      tabIdentity: { ...id1, cliSessionId: 'sess-2' },
    });
    expect(s2.read()).toEqual([]);
    expect(kv.getItem(key)).toBeNull();
  });

  it('旧格式仅标 attachmentsMissing 的整组仍可兼容写盘', async () => {
    const kv = memoryKv();
    const key = pendingKey('tab', 't2');
    const store = openPendingSends({ kv }, key);
    store.save(key, [
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
      { id: 'p2', text: '第二条', mode: 'queue' },
    ]);
    await store.persist('update');
    const stored = store.read() as StoredPendingSend[];
    expect(stored.map((s) => s.attachmentsMissing)).toEqual([true, undefined]);
    const raw = kv.getItem(key);
    expect(JSON.parse(raw ?? '[]')).toEqual([
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
      { id: 'p2', text: '第二条', mode: 'queue' },
    ]);
  });
});
