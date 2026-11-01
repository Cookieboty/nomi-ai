/**
 * `web` 事件源（§6.2）：HTTP 轮询网页 / RSS·Atom / JSON。条件请求（ETag / Last-Modified），没有就比内容哈希；
 * 订阅源按条目 id 去重。只拉公网地址（netGuard 预检 + 不跟随跳转），正文最多 2 MB。
 * Go 版：apps/desktop-go/internal/core/tasks/events/web.go。
 */
import { createHash } from 'node:crypto';

import { t } from '../../../i18n';
import { assertPublicHttpUrl, assertPublicHttpUrlResolved } from '../../../security/netGuard';
import type { EventSource, SourceEvent } from '../types';

export interface WebFilter {
  url: string;
  /** page：整页有变化；feed：RSS / Atom 的新条目 */
  kind?: 'page' | 'feed';
}

interface Cursor {
  etag?: string;
  lastModified?: string;
  hash?: string;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'manual' },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

const MAX_BODY = 2 * 1024 * 1024;

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

const tag = (block: string, name: string): string => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decode(m[1]!) : '';
};

/** RSS <item> / Atom <entry>：id、标题、链接、时间 */
export function parseFeed(xml: string): { id: string; title: string; link: string; at: number }[] {
  const out: { id: string; title: string; link: string; at: number }[] = [];
  const re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < 200) {
    const b = m[0];
    const atomLink = /<link\b[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? '';
    const link = tag(b, 'link') || decode(atomLink);
    const id = tag(b, 'guid') || tag(b, 'id') || link || tag(b, 'title');
    const when = Date.parse(tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published'));
    if (id) out.push({ id, title: tag(b, 'title'), link, at: Number.isFinite(when) ? when : 0 });
  }
  return out;
}

/** 网页正文：去脚本、样式与标签，压空白（比哈希、给执行者看摘录） */
export function pageText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  );
}

export function createWebSource(
  deps: {
    fetch?: FetchLike;
    /** 测试里跳过 DNS 解析 */
    resolve?: (url: string) => Promise<unknown>;
    now?: () => number;
  } = {},
): EventSource {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const resolve = deps.resolve ?? assertPublicHttpUrlResolved;
  const now = deps.now ?? Date.now;
  return {
    id: 'web',
    minIntervalMs: 15 * 60_000,
    validate(filter) {
      const f = filter as WebFilter | null;
      if (!f || typeof f.url !== 'string') return 'url required';
      try {
        assertPublicHttpUrl(f.url);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      if (f.kind !== undefined && f.kind !== 'page' && f.kind !== 'feed') return 'bad kind';
      return null;
    },
    async poll(filter, cursorRaw, ctx) {
      const f = filter as WebFilter;
      await resolve(f.url);
      const cur: Cursor = cursorRaw ? (JSON.parse(cursorRaw) as Cursor) : {};
      const headers: Record<string, string> = { 'user-agent': 'Nomi-Tasks/1' };
      if (cur.etag) headers['if-none-match'] = cur.etag;
      if (cur.lastModified) headers['if-modified-since'] = cur.lastModified;
      const res = await doFetch(f.url, { headers, signal: ctx.signal, redirect: 'manual' });
      if (res.status === 304) return { events: [], cursor: cursorRaw };
      if (res.status >= 300 && res.status < 400)
        throw new Error(`redirect not followed: ${res.status}`);
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      const body = (await res.text()).slice(0, MAX_BODY);
      const next: Cursor = {};
      const etag = res.headers.get('etag');
      const lm = res.headers.get('last-modified');
      if (etag) next.etag = etag;
      if (lm) next.lastModified = lm;
      const events: SourceEvent[] = [];
      if (f.kind === 'feed') {
        for (const it of parseFeed(body))
          events.push({
            key: `web:${f.url}:${it.id}`,
            occurredAt: it.at || now(),
            summary: t('electron.common.task-event-feed-item', it.title || it.link || it.id),
            payload: { url: f.url, title: it.title, link: it.link },
          });
        // 订阅源靠条目 key 去重（hub 的 seen）；第一次拉由 hub 当基线
        return { events, cursor: JSON.stringify(next) };
      }
      const text = pageText(body);
      next.hash = createHash('sha256').update(text).digest('hex').slice(0, 32);
      if (cur.hash && cur.hash !== next.hash)
        events.push({
          key: `web:${f.url}:${next.hash}`,
          occurredAt: now(),
          summary: t('electron.common.task-event-page-changed', f.url),
          payload: { url: f.url, excerpt: text.slice(0, 4000) },
        });
      return { events, cursor: JSON.stringify(next) };
    },
  };
}
