jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { strToU8, zipSync } from 'fflate';

import { extract, isSupported } from '../../../src/desktop/parse/extract';
import { odtXmlToText, rtfToText, xlsxToText } from '../../../src/desktop/parse/office';
import { buildAskMessages, citedNumbers, toSources } from '../../../src/knowledge/answer';
import { Bm25Index } from '../../../src/knowledge/bm25';
import { OCR_ASSETS } from '../../../src/knowledge/catalog';
import { chunkPages, chunkText } from '../../../src/knowledge/chunk';
import { KnowledgeIndex, type DocRec } from '../../../src/knowledge/KnowledgeIndex';
import { sanitizeKbSettings } from '../../../src/knowledge/settings';
import { tokenize } from '../../../src/knowledge/tokenize';
import { b64ToVec, cosine, embed, rerank, rrf, vecToB64 } from '../../../src/knowledge/vector';

const doc = (id: string, texts: string[], extra: Partial<DocRec> = {}): DocRec => ({
  id,
  sourceId: 's1',
  path: path.join(os.tmpdir(), `${id}.txt`),
  title: `${id}.txt`,
  ext: 'txt',
  mtime: 1,
  size: 1,
  indexedAt: 1,
  status: 'ok',
  chunks: texts.map((t, i) => ({ id: `${id}:${i}`, text: t, offset: 0 })),
  ...extra,
});

describe('tokenize', () => {
  it('splits latin words and CJK unigrams + bigrams', () => {
    expect(tokenize('Hello World, the 报销流程')).toEqual(
      expect.arrayContaining(['hello', 'world', '报', '销', '报销', '销流', '流程']),
    );
    expect(tokenize('the a of')).toEqual([]);
  });
});

describe('chunk', () => {
  it('chunks long text with overlap and keeps pages', () => {
    const t = Array.from({ length: 50 }, (_, i) => `第${i}段内容。`.repeat(10)).join('\n\n');
    const cs = chunkText(t, 400, 50);
    expect(cs.length).toBeGreaterThan(5);
    expect(cs.every((c) => c.text.length <= 400)).toBe(true);
    const ps = chunkPages(['page one text', 'page two text']);
    expect(ps.map((p) => p.page)).toEqual([1, 2]);
    expect(chunkText('   ')).toEqual([]);
  });
});

describe('Bm25Index', () => {
  it('ranks relevant docs first and round-trips JSON', () => {
    const b = new Bm25Index();
    b.add('a', '公司报销流程：发票需要在 30 天内提交');
    b.add('b', '年假政策：每年 10 天带薪年假');
    b.add('c', 'Quarterly revenue report for 2026');
    expect(b.search('报销发票')[0].id).toBe('a');
    expect(b.search('revenue')[0].id).toBe('c');
    const c = Bm25Index.fromJSON(JSON.parse(JSON.stringify(b.toJSON())));
    expect(c.search('年假')[0].id).toBe('b');
    c.remove('b');
    expect(c.search('年假')).toEqual([]);
    expect(c.size).toBe(2);
  });
});

describe('vector helpers', () => {
  it('cosine / base64 / rrf', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    const v = b64ToVec(vecToB64([0.5, -1, 2]));
    expect(Array.from(v)).toEqual([0.5, -1, 2]);
    expect(
      rrf([
        [{ id: 'x' }, { id: 'y' }],
        [{ id: 'y' }, { id: 'z' }],
      ])[0].id,
    ).toBe('y');
  });

  it('calls OpenAI-compatible embeddings and rerank endpoints', async () => {
    const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body, auth: (init.headers as Record<string, string>).authorization });
      if (url.endsWith('/embeddings'))
        return new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
          }),
        );
      return new Response(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.1 },
          ],
        }),
      );
    };
    const ep = { baseURL: 'http://127.0.0.1:11434/v1/', model: 'nomic-embed-text', apiKey: 'k' };
    const vs = await embed(ep, ['a', 'b'], { fetchImpl });
    expect(Array.from(vs[0])).toEqual([1, 0]);
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/embeddings');
    expect(calls[0].auth).toBe('Bearer k');
    expect(await rerank(ep, 'q', ['a', 'b'], { fetchImpl })).toEqual([0.1, 0.9]);
    await expect(
      embed(ep, ['a'], { fetchImpl: async () => new Response('x', { status: 500 }) }),
    ).rejects.toThrow('HTTP 500');
  });
});

describe('KnowledgeIndex', () => {
  it('searches, limits per doc, filters sources, fuses vectors and persists', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-kb-')), 'index.json');
    const idx = new KnowledgeIndex(file);
    idx.put(
      doc('expense', ['报销流程：发票 30 天内提交', '报销需要主管审批', '报销金额上限 5000']),
    );
    idx.put(doc('leave', ['年假每年十天'], { sourceId: 's2' }));
    idx.put(
      doc('vec', ['completely unrelated words'], {
        embedModel: 'p:m',
        chunks: [
          { id: 'vec:0', text: 'completely unrelated words', offset: 0, vec: vecToB64([1, 0]) },
        ],
      }),
    );
    const hits = idx.search('报销', { limit: 5 });
    expect(hits.filter((h) => h.docId === 'expense')).toHaveLength(2);
    expect(idx.search('年假', { sourceIds: ['s1'] })).toEqual([]);
    const v = idx.search('报销', { queryVec: Float32Array.from([1, 0]), embedModel: 'p:m' });
    expect(v.some((h) => h.docId === 'vec')).toBe(true);
    expect(idx.stats()).toEqual({ docs: 3, chunks: 5, vectors: 1, errors: 0 });
    idx.save();
    const again = new KnowledgeIndex(file);
    expect(again.search('审批')[0].docId).toBe('expense');
    expect(
      again
        .search('unrelated', { queryVec: Float32Array.from([1, 0]), embedModel: 'p:m' })
        .some((h) => h.docId === 'vec'),
    ).toBe(true);
    expect(again.removeSource('s2')).toBe(1);
    expect(again.list()).toHaveLength(2);
  });
});

describe('cited answers', () => {
  const hits = [
    { chunkId: 'a:0', docId: 'a', path: '/x/a.md', title: 'a.md', text: 'alpha', score: 1 },
    {
      chunkId: 'b:0',
      docId: 'b',
      path: '/x/b.pdf',
      title: 'b.pdf',
      page: 3,
      text: 'beta',
      score: 0.5,
    },
  ];
  it('numbers sources, guards against injection and keeps only cited ones', () => {
    const m = buildAskMessages('什么是 beta？', hits);
    expect(m[0].content).toContain('不可信');
    expect(m[m.length - 1].content).toContain('[2] 来源：b.pdf（第 3 页）');
    expect(citedNumbers('见 [2] 和 [9] 以及 [2]', 2)).toEqual([2]);
    expect(toSources(hits, 'beta 是 [2]').map((s) => s.n)).toEqual([2]);
    expect(toSources(hits, '没有标注')).toHaveLength(2);
  });
});

describe('settings', () => {
  it('sanitizes', () => {
    const s = sanitizeKbSettings({
      sources: [
        { id: '1', kind: 'folder', path: 'C:\\Docs' },
        { id: '2', kind: 'folder' },
        { id: '3', kind: 'notes' },
      ],
      topK: 99,
      ocr: { enabled: true, langs: ['eng', 'xx'] },
      embed: { enabled: true, providerId: 'p', model: 'm' },
    });
    expect(s.sources.map((x) => x.id)).toEqual(['1', '3']);
    expect(s.sources[0].path).toBe('C:\\Docs');
    expect(s.topK).toBe(12);
    expect(s.ocr.langs).toEqual(['eng']);
    expect(s.embed.enabled).toBe(true);
    expect(sanitizeKbSettings(null).sources).toEqual([]);
  });
  it('pins OCR assets with sha256 and permissive licences', () => {
    for (const a of OCR_ASSETS) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.license).toBe('Apache-2.0');
      expect(a.url).toMatch(/tessdata_fast\/[0-9a-f]{40}\//);
    }
  });
});

describe('office formats', () => {
  it('odt', () => {
    const xml =
      '<office:text><text:h>标题</text:h><text:p>第一段<text:tab/>A&amp;B</text:p><text:p>x<text:s text:c="2"/>y</text:p></office:text>';
    expect(odtXmlToText(xml)).toBe('标题\n第一段\tA&B\nx  y');
  });

  it('xlsx', async () => {
    const files = {
      'xl/workbook.xml': strToU8(
        '<workbook><sheets><sheet name="预算" sheetId="1"/></sheets></workbook>',
      ),
      'xl/sharedStrings.xml': strToU8(
        '<sst><si><t>项目</t></si><si><r><t>金</t></r><r><t>额</t></r></si></sst>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>差旅</t></is></c><c r="C2"><v>1200</v></c></row></sheetData>',
      ),
    };
    expect(xlsxToText(files)).toBe('## 预算\n项目\t\t金额\n差旅\t\t1200');
    const buf = zipSync(files);
    const r = await extract(buf, 'C:\\data\\budget.xlsx');
    expect(r.text).toContain('差旅');
    expect(isSupported('/a/b.odt') && isSupported('x.rtf') && isSupported('x.xlsx')).toBe(true);
  });

  it('rtf incl. unicode escapes and GBK hex', async () => {
    const rtf =
      "{\\rtf1\\ansi\\ansicpg936{\\fonttbl{\\f0 SimSun;}}{\\*\\generator x;}\\f0 Hello \\b bold\\b0\\par \\u20013?\\u25991? \\'d6\\'d0\\par}";
    expect(rtfToText(rtf)).toBe('Hello bold\n中文 中');
    const r = await extract(strToU8(rtf), '/tmp/x.rtf');
    expect(r.mime).toBe('application/rtf');
    expect(() => rtfToText('nope')).toThrow();
  });
});
