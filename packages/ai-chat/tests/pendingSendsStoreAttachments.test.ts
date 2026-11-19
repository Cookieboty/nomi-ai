/**
 * 带图的那条自动发送失败、落盘只留得下正文（图按现有策略不落盘）：存下的那份要标「附件缺失」，
 * 重启后恢复时不把残缺的正文当原消息自动发出去。
 * 回归：标记刚打在传进来的条目上（failQueuedSend 里 store.save(...map(markAttachmentsMissing))，已存下的
 * 那份往往还没有这个标记）时，清洗不能把它丢掉；读回后再写也不能丢；重新附上图片后要清掉。
 */
import { describe, expect, it } from 'vitest';

import {
  openPendingSends,
  pendingKey,
  readStoredPendingSends,
  storedPendingSends,
  type Kv,
  type StoredPendingSend,
} from '../src/services/pendingSendsStore';
import type { PendingSend } from '../src/utils/pendingSends';

const img = (data: string) => ({ mime: 'image/png', data, width: 4, height: 4, source: 'paste' });

/** 落盘时只剩正文的那条（failQueuedSend 打在传入条目上的标记） */
const onlyText = (id: string, text: string): PendingSend =>
  ({ id, text, mode: 'queue', attachmentsMissing: true }) as PendingSend;

function memoryKv(): Kv {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

describe('storedPendingSends 保留「附件缺失」', () => {
  it('传进来的条目上刚打上的标记：没有图时保留（已存下的那份还没有）', () => {
    const out = storedPendingSends([onlyText('p1', '第一条')]);
    expect(out).toEqual([{ id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true }]);
  });

  it('没图的条目不凭空加标记（正文与图片一致才做替代判定，不同附件的消息不会被当成它）', () => {
    const out = storedPendingSends([{ id: 'p1', text: '第一条', mode: 'queue' }]);
    expect(out).toEqual([{ id: 'p1', text: '第一条', mode: 'queue' }]);
    // 带图的那条在内存里没标：存下的那份（旧的）标了也保留
    const withOld = storedPendingSends(
      [{ id: 'p1', text: '第一条', mode: 'queue' }],
      [{ id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true }],
    );
    expect(withOld).toEqual([
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
    ]);
  });

  it('从带标记的 raw 读回后再 save：标记不丢', () => {
    const raw = [
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
      { id: 'p2', text: '第二条', mode: 'queue' },
    ];
    const read = readStoredPendingSends(raw);
    expect(read.map((s) => s.attachmentsMissing)).toEqual([true, undefined]);
    // 界面挂回后是 PendingSend（没有这个字段），再写回去要按已存下的那份保留
    const resaved = storedPendingSends(
      read.map((s) => ({ id: s.id, text: s.text, mode: s.mode })),
      read,
    );
    expect(resaved).toEqual(raw);
  });

  it('重新附上图片：标记清掉（附件齐了就不是残缺的）', () => {
    const out = storedPendingSends(
      [{ id: 'p1', text: '第一条', mode: 'queue', images: [img('QUJD')] } as PendingSend],
      [{ id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true }],
    );
    expect(out).toEqual([{ id: 'p1', text: '第一条', mode: 'queue' }]);
    // 传进来的条目自己带着标记、但也带着图：同样清掉
    const withImages = storedPendingSends([
      {
        id: 'p1',
        text: '第一条',
        mode: 'queue',
        images: [img('QUJD')],
        attachmentsMissing: true,
      } as PendingSend,
    ]);
    expect(withImages).toEqual([{ id: 'p1', text: '第一条', mode: 'queue' }]);
  });
});

describe('openPendingSends：save() → 读回 → 再 save → 从 raw 恢复', () => {
  it('刚打上的标记经 save()/persist 写稳，重启（新的一组）读回时仍在', async () => {
    const kv = memoryKv();
    const key = pendingKey('tab', 't1');
    const a = openPendingSends({ kv }, key);
    // failQueuedSend：先存下正文（带图的那条落盘只留得下正文），然后整组标上「附件缺失」
    a.save(key, [{ id: 'p1', text: '第一条', mode: 'queue' }]);
    a.save(
      key,
      a.read().map((s) => ({ ...s, attachmentsMissing: true as const })),
    );
    await a.persist('update');
    expect(a.read()).toEqual([
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
    ]);

    // 「重启」：新的一组从 localStorage 读回
    const b = openPendingSends({ kv }, key);
    expect(b.read()).toEqual([
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
    ]);
    // 读回后再写一遍（挂回时会把列表再存一次：界面上的条目没有标记）
    b.save(
      key,
      b.read().map((s) => ({ id: s.id, text: s.text, mode: s.mode })),
    );
    expect(b.read()).toEqual([
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
    ]);
    await b.persist('update');
  });

  it('failQueuedSend 把 flag 打进传入条目再整组 save（old 里还没有）：标记写进 localStorage', async () => {
    const kv = memoryKv();
    const key = pendingKey('tab', 't2');
    const store = openPendingSends({ kv }, key);
    // 队列里本来排着两条（旧的：没有标记）
    store.save(key, [
      { id: 'p1', text: '第一条', mode: 'queue' },
      { id: 'p2', text: '第二条', mode: 'queue' },
    ]);
    await store.persist('update');
    // 落盘的那份（stored→PendingSend）再整组标上标记后 save：和 failQueuedSend 里一样
    const stored = store.read() as StoredPendingSend[];
    store.save(
      key,
      stored.map((s) => ({ ...s, attachmentsMissing: true as const }) as PendingSend),
    );
    expect(store.read().every((s) => s.attachmentsMissing === true)).toBe(true);
    await store.persist('update');
    const raw = kv.getItem(key);
    expect(JSON.parse(raw ?? '[]')).toEqual([
      { id: 'p1', text: '第一条', mode: 'queue', attachmentsMissing: true },
      { id: 'p2', text: '第二条', mode: 'queue', attachmentsMissing: true },
    ]);
  });
});
