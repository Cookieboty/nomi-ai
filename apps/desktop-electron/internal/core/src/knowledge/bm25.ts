import { tokenize } from './tokenize';

/**
 * 增量 BM25 倒排索引（纯逻辑，可序列化为 JSON）。文档 = 一个分块，id 由调用方给出。
 */
export interface Bm25Json {
  v: 1;
  docs: Array<[string, number, Record<string, number>]>;
}

export class Bm25Index {
  private readonly tf = new Map<string, Map<string, number>>(); // docId → term → count
  private readonly len = new Map<string, number>();
  private readonly df = new Map<string, number>();
  private totalLen = 0;

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.len.size;
  }

  add(id: string, text: string): void {
    this.addTerms(id, tokenize(text));
  }

  private addTerms(id: string, terms: string[] | Map<string, number>): void {
    if (this.len.has(id)) this.remove(id);
    let m: Map<string, number>;
    let n = 0;
    if (terms instanceof Map) {
      m = terms;
      for (const c of m.values()) n += c;
    } else {
      m = new Map();
      for (const t of terms) m.set(t, (m.get(t) ?? 0) + 1);
      n = terms.length;
    }
    this.tf.set(id, m);
    this.len.set(id, n);
    this.totalLen += n;
    for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  remove(id: string): void {
    const m = this.tf.get(id);
    if (!m) return;
    for (const t of m.keys()) {
      const d = (this.df.get(t) ?? 1) - 1;
      if (d <= 0) this.df.delete(t);
      else this.df.set(t, d);
    }
    this.totalLen -= this.len.get(id) ?? 0;
    this.tf.delete(id);
    this.len.delete(id);
  }

  search(
    query: string,
    limit = 20,
    filter?: (id: string) => boolean,
  ): Array<{ id: string; score: number }> {
    const q = [...new Set(tokenize(query))];
    if (!q.length || !this.len.size) return [];
    const N = this.len.size;
    const avg = this.totalLen / N || 1;
    const scores = new Map<string, number>();
    for (const term of q) {
      const df = this.df.get(term);
      if (!df) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [id, m] of this.tf) {
        const f = m.get(term);
        if (!f) continue;
        if (filter && !filter(id)) continue;
        const dl = this.len.get(id) ?? 0;
        const s = (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * dl) / avg));
        scores.set(id, (scores.get(id) ?? 0) + s);
      }
    }
    return [...scores]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  toJSON(): Bm25Json {
    return {
      v: 1,
      docs: [...this.tf].map(([id, m]) => [id, this.len.get(id) ?? 0, Object.fromEntries(m)]),
    };
  }

  static fromJSON(j: unknown): Bm25Index {
    const idx = new Bm25Index();
    const o = j as Partial<Bm25Json> | null;
    if (!o || o.v !== 1 || !Array.isArray(o.docs)) return idx;
    for (const d of o.docs) {
      if (!Array.isArray(d) || typeof d[0] !== 'string' || !d[2] || typeof d[2] !== 'object')
        continue;
      idx.addTerms(d[0], new Map(Object.entries(d[2]).filter(([, c]) => typeof c === 'number')));
    }
    return idx;
  }
}
