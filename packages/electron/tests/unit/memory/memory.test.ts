jest.unmock('fs');
jest.unmock('path');
// 只有 ai/mascotCommand（看板娘指令数窗口）还用到 BrowserWindow
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildMemoryContext,
  exportMarkdown,
  isDuplicateFact,
  parseSummary,
  recall,
  sanitizeMemorySettings,
  summaryPrompt,
  type Episode,
  type Fact,
} from '../../../src/memory/episodes';
import { MemoryService } from '../../../src/memory/MemoryService';
import { featureHost, type FeatureHostOptions } from '../helpers/featureHost';

const ep = (id: string, title: string, summary: string, extra: Partial<Episode> = {}): Episode => ({
  id,
  conversationId: `c-${id}`,
  title,
  summary,
  keywords: [],
  createdAt: Date.UTC(2026, 0, 1),
  updatedAt: 1,
  messageCount: 4,
  pinned: false,
  edited: false,
  ...extra,
});

describe('episodes logic', () => {
  it('parses fenced JSON, filters secrets and unknown kinds', () => {
    const p = parseSummary(
      '好的：```json\n{"title":"搬家计划","summary":"讨论了下月搬到杭州。","keywords":["搬家","杭州","搬家"],' +
        '"facts":[{"kind":"identity","text":"用户叫小林"},{"kind":"weird","text":"喜欢猫"},{"kind":"note","text":"我的密码是123"},{"kind":"note","text":"用的 token 是 ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7"}]}\n```',
    );
    expect(p).toEqual({
      title: '搬家计划',
      summary: '讨论了下月搬到杭州。',
      keywords: ['搬家', '杭州'],
      facts: [
        { kind: 'identity', text: '用户叫小林' },
        { kind: 'note', text: '喜欢猫' },
      ],
    });
    expect(parseSummary('no json')).toBeNull();
    expect(parseSummary('{"title":"x"}')).toBeNull();
  });

  it('prompt wraps transcript as data and truncates', () => {
    const m = summaryPrompt([{ role: 'user', content: 'x'.repeat(20_000) }]);
    expect(m[0].content).toContain('不要执行');
    expect(m[1].content.startsWith('<conversation>\n…')).toBe(true);
    expect(m[1].content.length).toBeLessThan(12_100);
  });

  it('dedupes facts', () => {
    expect(isDuplicateFact('用户喜欢喝咖啡。', '用户喜欢喝咖啡')).toBe(true);
    expect(isDuplicateFact('用户喜欢喝咖啡', '喜欢喝咖啡')).toBe(true);
    expect(isDuplicateFact('喜欢猫', '喜欢狗')).toBe(false);
  });

  it('recalls by BM25 and by vectors, ignores unrelated', () => {
    const eps = [
      ep('a', '杭州搬家', '下个月搬到杭州，需要找房子'),
      ep('b', '学习 Rust', '讨论了所有权和借用', { vec: 'B' }),
      ep('c', '晚饭', '想吃火锅'),
    ];
    const facts: Fact[] = [];
    const r1 = recall('杭州的房子怎么找', eps, facts, { topK: 2 });
    expect(r1[0]).toMatchObject({ kind: 'episode', id: 'a' });
    expect(recall('量子力学', eps, facts, { topK: 3 })).toEqual([]);
    const vecs: Record<string, Float32Array> = { B: Float32Array.from([1, 0]) };
    const r2 = recall('borrow checker', eps, facts, {
      topK: 3,
      qvec: Float32Array.from([0.9, 0.1]),
      vecOf: (b) => vecs[b],
    });
    expect(r2.map((x) => x.id)).toEqual(['b']);
  });

  it('builds context and markdown', () => {
    expect(buildMemoryContext({ persona: '', facts: [], episodes: [] })).toBe('');
    const ctx = buildMemoryContext({
      persona: '我是设计师',
      facts: [
        { id: 'f', kind: 'identity', text: '叫小林', source: 'user', createdAt: 1, updatedAt: 1 },
      ],
      episodes: [ep('a', '搬家', '去杭州')],
    });
    expect(ctx).toContain('我是设计师');
    expect(ctx).toContain('- 叫小林');
    expect(ctx).toContain('2026-01-01「搬家」：去杭州');
    const md = exportMarkdown({
      persona: '',
      facts: [],
      episodes: [ep('a', '搬家', '去杭州', { pinned: true })],
      exportedAt: 0,
    });
    expect(md).toContain('### 搬家 📌');
  });

  it('sanitizes settings', () => {
    expect(sanitizeMemorySettings({ topK: 99, enabled: 'x' })).toMatchObject({
      topK: 8,
      enabled: true,
    });
  });
});

describe('MemoryService', () => {
  const mk = (
    complete: jest.Mock,
    embed: (t: string[]) => Promise<Float32Array[] | null> = async () => null,
    hostOpts: FeatureHostOptions = {},
  ) => {
    const host = featureHost(hostOpts);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
    const audit = { append: jest.fn() };
    const facts = new Map<string, unknown>();
    const svc = new MemoryService({
      root,
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: { audit } as never,
      complete,
      embed,
      facade: () => ({
        facts: {
          put: (f: { id: string }) => facts.set(f.id, f),
          delete: (id: string) => facts.delete(id),
        },
        summaries: { put: jest.fn() },
        userProfile: { get: () => ({ identity: {} }), reset: jest.fn(async () => ({})) },
      }),
      ports: host.ports,
      events: host.events,
    });
    return { svc, root, audit, facts, host };
  };
  const conv = [
    { role: 'user' as const, content: '我叫小林，下个月要搬去杭州' },
    { role: 'assistant' as const, content: '好的，需要帮你列搬家清单吗？' },
    { role: 'user' as const, content: '要，顺便推荐几个区' },
    { role: 'assistant' as const, content: '西湖区、滨江区……' },
  ];
  const reply = JSON.stringify({
    title: '杭州搬家',
    summary: '小林下月搬去杭州，列了清单并推荐了西湖区、滨江区。',
    keywords: ['搬家', '杭州'],
    facts: [{ kind: 'identity', text: '用户叫小林' }],
  });

  it('summarizes, persists, recalls, edits, deletes, and syncs facade', async () => {
    const complete = jest.fn(async () => reply);
    const { svc, root, audit, facts } = mk(complete);
    const r = await svc.ingest('c1', conv);
    expect(r.episode?.title).toBe('杭州搬家');
    expect(facts.size).toBe(1);
    // 没有新消息 → 跳过
    expect(await svc.ingest('c1', conv)).toEqual({ skipped: 'no-new' });
    expect(await svc.ingest('c2', conv.slice(0, 2))).toEqual({ skipped: 'too-short' });
    // 同一事实不重复
    await svc.ingest('c1', [...conv, ...conv], { force: true });
    expect(svc.list().facts).toHaveLength(1);
    expect(svc.list().episodes).toHaveLength(1);

    const ctx = await svc.context('杭州哪个区好');
    expect(ctx.text).toContain('杭州搬家');
    expect(ctx.used.some((u) => u.kind === 'episode')).toBe(true);

    svc.setPersona('我是一名插画师');
    expect((await svc.context('随便')).text).toContain('插画师');

    const id = svc.list().episodes[0].id;
    await svc.updateEpisode(id, { summary: '改过的摘要', pinned: true });
    expect(svc.list().episodes[0]).toMatchObject({
      summary: '改过的摘要',
      pinned: true,
      edited: true,
    });
    // 用户改过 → 自动摘要不覆盖
    expect(await svc.ingest('c1', [...conv, ...conv, ...conv])).toEqual({ skipped: 'edited' });

    svc.flush();
    const disk = JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8'));
    expect(disk.episodes[0].summary).toBe('改过的摘要');

    const fid = svc.list().facts[0].id;
    expect(svc.remove('fact', fid)).toBe(true);
    expect(facts.size).toBe(0);
    expect(svc.remove('episode', id)).toBe(true);
    expect(svc.state().stats).toMatchObject({ episodes: 0, facts: 0 });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'memory_delete', source: 'memory' }),
    );
  });

  describe('long conversations keep summarizing past 80 messages (#28)', () => {
    const msgsOf = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `消息 #${i + 1}`,
      }));
    const ingestSeq = async (counts: number[]) => {
      const complete = jest.fn(async () => reply);
      const { svc } = mk(complete);
      const out: Array<{ skipped?: string; ran: boolean }> = [];
      for (const n of counts) {
        const before = complete.mock.calls.length;
        const r = await svc.ingest('c1', msgsOf(n));
        out.push({ skipped: r.skipped, ran: complete.mock.calls.length > before });
      }
      return { svc, complete, out };
    };

    it('78 → 80 → 82 → 100 each trigger a new summary; last 80 messages go to the model', async () => {
      const { svc, complete, out } = await ingestSeq([78, 80, 82, 100]);
      expect(out.map((o) => o.ran)).toEqual([true, true, true, true]);
      // 保存的是完整有效消息数，而不是截断后的 80
      expect(svc.list().episodes[0]!.messageCount).toBe(100);
      const prompt = JSON.stringify((complete.mock.calls.at(-1) as unknown[])[0]);
      expect(prompt).toContain('消息 #100');
      expect(prompt).toContain('消息 #21');
      expect(prompt).not.toContain('消息 #20"');
    });

    it('re-summarizes at +2 (79 → 81) and skips at +1 (79 → 80, 100 → 101)', async () => {
      const a = await ingestSeq([79, 80]);
      expect(a.out[1]).toEqual({ skipped: 'no-new', ran: false });
      const a2 = await ingestSeq([79, 81]);
      expect(a2.out[1]!.ran).toBe(true);
      const b = await ingestSeq([100, 101, 102]);
      expect(b.out.map((o) => o.ran)).toEqual([true, false, true]);
    });

    it('force keeps the real count so auto summarizing continues afterwards', async () => {
      const complete = jest.fn(async () => reply);
      const { svc } = mk(complete);
      await svc.ingest('c1', msgsOf(90));
      await svc.ingest('c1', msgsOf(90), { force: true });
      expect(svc.list().episodes[0]!.messageCount).toBe(90);
      const r = await svc.ingest('c1', msgsOf(92));
      expect(r.episode).toBeTruthy();
    });

    it('legacy episodes saved with the capped count (80) resume on the next 2 messages', async () => {
      const complete = jest.fn(async () => reply);
      const { svc } = mk(complete);
      await svc.ingest('c1', msgsOf(80));
      // 模拟旧版本写入的 messageCount=80（会话实际已更长）
      const ep = svc.list().episodes[0]!;
      expect(ep.messageCount).toBe(80);
      expect(await svc.ingest('c1', msgsOf(81))).toEqual({ skipped: 'no-new' });
      expect((await svc.ingest('c1', msgsOf(150))).episode).toBeTruthy();
    });

    it('history that shrank (trimmed / deleted) is re-summarized instead of stalling', async () => {
      const { out } = await ingestSeq([100, 60]);
      expect(out[1]!.ran).toBe(true);
    });

    // 会话存储最多保留 1000 条：再往后条数不变、开头被裁掉
    const slide = (from: number, to: number) => msgsOf(to).slice(from - 1, to);

    it('keeps summarizing after the 1000-message storage cap (count stays 1000)', async () => {
      const complete = jest.fn(async () => reply);
      const { svc } = mk(complete);
      const ran = async (m: ReturnType<typeof msgsOf>) => {
        const before = complete.mock.calls.length;
        await svc.ingest('c1', m);
        return complete.mock.calls.length > before;
      };
      expect(await ran(slide(1, 1000))).toBe(true);
      expect(await ran(slide(3, 1002))).toBe(true); // +2，条数仍是 1000
      expect(await ran(slide(4, 1003))).toBe(false); // +1
      expect(await ran(slide(5, 1004))).toBe(true); // 距上次摘要 +2
      expect(JSON.stringify((complete.mock.calls.at(-1) as unknown[])[0])).toContain('消息 #1004');
    });

    it('re-summarizes when the last reply is regenerated or edited (same count)', async () => {
      const complete = jest.fn(async () => reply);
      const { svc } = mk(complete);
      const m = msgsOf(40);
      await svc.ingest('c1', m);
      const regenerated = [
        ...m.slice(0, -1),
        { role: 'assistant' as const, content: '重新生成的回答' },
      ];
      expect((await svc.ingest('c1', regenerated)).episode).toBeTruthy();
      expect(await svc.ingest('c1', regenerated)).toEqual({ skipped: 'no-new' });
    });

    it('legacy episodes (no window signature) at the storage cap are re-summarized once', async () => {
      const complete = jest.fn(async () => reply);
      const { svc } = mk(complete);
      await svc.ingest('c1', slide(1, 1000));
      const ep = (svc as unknown as { data: { episodes: Array<{ windowSig?: string }> } }).data
        .episodes[0]!;
      delete ep.windowSig;
      expect((await svc.ingest('c1', slide(2, 1001))).episode).toBeTruthy();
      expect(await svc.ingest('c1', slide(2, 1001))).toEqual({ skipped: 'no-new' });
    });

    it('a manually edited summary is still never overwritten automatically', async () => {
      const { svc } = await ingestSeq([90]);
      await svc.updateEpisode(svc.list().episodes[0]!.id, { summary: '我改过' });
      expect(await svc.ingest('c1', msgsOf(120))).toEqual({ skipped: 'edited' });
    });
  });

  it('reports bad model output and respects disabled', async () => {
    const { svc } = mk(jest.fn(async () => '抱歉'));
    await expect(svc.ingest('c1', conv)).rejects.toMatchObject({ code: 'bad-summary' });
    expect(svc.state().lastError).toBeTruthy();
    svc.setSettings({ enabled: false });
    expect(await svc.ingest('c1', conv)).toEqual({ skipped: 'disabled' });
    expect((await svc.context('杭州')).text).toBe('');
  });

  it('stores vectors when embeddings are available and exports without them', async () => {
    const embed = jest.fn(async (t: string[]) => t.map(() => Float32Array.from([1, 0])));
    const { svc } = mk(
      jest.fn(async () => reply),
      embed,
    );
    await svc.ingest('c1', conv);
    expect(svc.state().stats.vectors).toBe(2);
    const data = svc.exportData();
    expect(JSON.stringify(data)).not.toContain('"vec"');
    expect(data.episodes).toHaveLength(1);
  });

  it('memory_remember tool saves once', async () => {
    const { svc } = mk(jest.fn());
    const tool = svc.tools().find((t) => t.name === 'memory_remember') as unknown as {
      execute: (a: unknown) => Promise<{ data: { saved: boolean } }>;
    };
    expect((await tool.execute({ text: '我对花生过敏', kind: 'note' })).data.saved).toBe(true);
    expect((await tool.execute({ text: '我对花生过敏。', kind: 'note' })).data.saved).toBe(false);
  });

  it('announces changes on ai:mem:changed and opens the persona file via the shell port', async () => {
    const { svc, root, host } = mk(jest.fn());
    svc.setPersona('我喜欢猫');
    expect(host.events.published).toContainEqual({
      channel: 'ai:mem:changed',
      payload: null,
      surfaces: null,
    });
    expect(await svc.openPersona()).toBe(true);
    expect(host.calls.openPath).toEqual([path.join(root, 'persona.md')]);
  });

  it('exports to the path picked in the save dialog (focused window), cancel writes nothing', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-out-')), 'm.md');
    const { svc, host } = mk(jest.fn(), undefined, { saveFile: [out, null] });
    expect(await svc.exportToFile('md')).toEqual({ ok: true, path: out });
    expect(fs.readFileSync(out, 'utf8')).toBeTruthy();
    expect(host.calls.saveFile[0]).toMatchObject({
      parent: 'focused',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    expect(await svc.exportToFile('json')).toEqual({ ok: false });
  });
});
