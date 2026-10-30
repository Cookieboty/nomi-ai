import { t } from '../i18n';
/**
 * 向量检索与 OpenAI 兼容的 embeddings / rerank 客户端（Ollama、LM Studio、vLLM、llama.cpp server、
 * 以及云端兼容服务）。只在主进程里调用；key 不离开主进程。
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Endpoint {
  baseURL: string;
  apiKey?: string;
  model: string;
}

const trimBase = (u: string) => u.replace(/\/+$/, '');

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Float32 向量 ↔ base64，节省索引文件体积 */
export function vecToB64(v: number[] | Float32Array): string {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}
export function b64ToVec(s: string): Float32Array {
  const b = Buffer.from(s, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Float32Array(ab);
}

function headers(ep: Endpoint): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}),
  };
}

export async function embed(
  ep: Endpoint,
  inputs: string[],
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<Float32Array[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${trimBase(ep.baseURL)}/embeddings`, {
    method: 'POST',
    headers: headers(ep),
    body: JSON.stringify({ model: ep.model, input: inputs }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(t('electron.common.embeddings-request-failed-http', res.status));
  const j = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
  if (!Array.isArray(j.data) || j.data.length !== inputs.length)
    throw new Error(t('electron.common.embeddings-response-is-malformed'));
  return [...j.data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => Float32Array.from(d.embedding));
}

/**
 * rerank：Jina / Cohere / llama.cpp server / TEI 通用的 `POST {base}/rerank`
 * （body: model, query, documents；返回 results[].index + relevance_score）。
 */
export async function rerank(
  ep: Endpoint,
  query: string,
  documents: string[],
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<number[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${trimBase(ep.baseURL)}/rerank`, {
    method: 'POST',
    headers: headers(ep),
    body: JSON.stringify({ model: ep.model, query, documents, top_n: documents.length }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(t('electron.common.rerank-request-failed-http', res.status));
  const j = (await res.json()) as {
    results?: Array<{ index: number; relevance_score?: number; score?: number }>;
  };
  if (!Array.isArray(j.results)) throw new Error(t('electron.common.rerank-response-is-malformed'));
  const scores = new Array<number>(documents.length).fill(-Infinity);
  for (const r of j.results)
    if (r.index >= 0 && r.index < documents.length)
      scores[r.index] = r.relevance_score ?? r.score ?? 0;
  return scores;
}

/** Reciprocal Rank Fusion：融合 BM25 与向量两路排序 */
export function rrf(
  lists: Array<Array<{ id: string }>>,
  k = 60,
): Array<{ id: string; score: number }> {
  const s = new Map<string, number>();
  for (const l of lists) l.forEach((x, i) => s.set(x.id, (s.get(x.id) ?? 0) + 1 / (k + i + 1)));
  return [...s].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
