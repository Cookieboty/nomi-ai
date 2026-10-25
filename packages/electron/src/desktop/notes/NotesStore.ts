import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { t as tr } from '../../i18n';

/**
 * 本地 markdown 笔记库：<root>/<id>.md，头部是 JSON 值的 front matter（title / tags / created / updated）。
 * 笔记由应用自己管理（按 id 访问，不接受路径），所以不经过文件夹授权；删除一律进应用回收站。
 * 搜索：内存索引 + 分词子串匹配（中日文按字符子串），标题 > 标签 > 正文 加权。
 */
export interface NoteMeta {
  id: string;
  title: string;
  tags: string[];
  created: number;
  updated: number;
}
export interface Note extends NoteMeta {
  body: string;
}
export interface NoteHit extends NoteMeta {
  score: number;
  snippet: string;
}

export const NOTE_ID = /^n[0-9a-z]{6,24}$/;
const MAX_BODY = 200_000;

export function serializeNote(n: Note): string {
  return [
    '---',
    `title: ${JSON.stringify(n.title)}`,
    `tags: ${JSON.stringify(n.tags)}`,
    `created: ${JSON.stringify(new Date(n.created).toISOString())}`,
    `updated: ${JSON.stringify(new Date(n.updated).toISOString())}`,
    '---',
    '',
    n.body,
  ].join('\n');
}

export function parseNote(id: string, raw: string): Note {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const meta: Record<string, unknown> = {};
  let body = raw;
  if (m) {
    body = m[2]!.replace(/^\r?\n/, '');
    for (const line of m[1]!.split(/\r?\n/)) {
      const k = /^(\w+):\s*(.*)$/.exec(line);
      if (!k) continue;
      try {
        meta[k[1]!] = JSON.parse(k[2]!);
      } catch {
        meta[k[1]!] = k[2];
      }
    }
  }
  const time = (v: unknown) => {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  const firstLine = body.split('\n').find((l) => l.trim()) ?? '';
  return {
    id,
    title:
      typeof meta.title === 'string' && meta.title
        ? meta.title
        : firstLine.replace(/^#+\s*/, '').slice(0, 80) || tr('electron.common.untitled'),
    tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [],
    created: time(meta.created),
    updated: time(meta.updated),
    body,
  };
}

const norm = (s: string) => s.toLowerCase().normalize('NFKC');
export const cleanTags = (tags: unknown): string[] =>
  Array.isArray(tags)
    ? [
        ...new Set(
          tags
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim().replace(/^#/, '').slice(0, 40))
            .filter(Boolean),
        ),
      ].slice(0, 20)
    : [];

export function scoreNote(n: Note, query: string): { score: number; snippet: string } | null {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const title = norm(n.title);
  const tags = n.tags.map(norm);
  const body = norm(n.body);
  let score = 0;
  let firstHit = -1;
  for (const t of terms) {
    const tag = t.replace(/^#/, '');
    let s = 0;
    if (title.includes(t)) s += 5;
    if (tags.some((x) => x === tag)) s += 4;
    else if (tags.some((x) => x.includes(tag))) s += 2;
    let i = body.indexOf(t);
    if (i >= 0 && firstHit < 0) firstHit = i;
    let c = 0;
    while (i >= 0 && c < 20) {
      c += 1;
      i = body.indexOf(t, i + t.length);
    }
    s += Math.min(c, 5);
    if (s === 0) return null; // 每个词都要命中（AND）
    score += s;
  }
  const at = Math.max(0, firstHit - 30);
  const snippet =
    firstHit >= 0
      ? `${at > 0 ? '…' : ''}${n.body.slice(at, at + 120).replace(/\s+/g, ' ')}${at + 120 < n.body.length ? '…' : ''}`
      : n.body.slice(0, 120).replace(/\s+/g, ' ');
  return { score, snippet };
}

export class NotesStore {
  private cache: Map<string, Note> | null = null;

  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  fileOf(id: string): string {
    if (!NOTE_ID.test(id))
      throw Object.assign(new Error(tr('electron.common.invalid-note-id')), { code: 'invalid' });
    return path.join(this.root, `${id}.md`);
  }

  private load(): Map<string, Note> {
    if (this.cache) return this.cache;
    const m = new Map<string, Note>();
    if (fs.existsSync(this.root)) {
      for (const f of fs.readdirSync(this.root)) {
        const id = f.replace(/\.md$/, '');
        if (!f.endsWith('.md') || !NOTE_ID.test(id)) continue;
        try {
          m.set(id, parseNote(id, fs.readFileSync(path.join(this.root, f), 'utf8')));
        } catch {
          /* skip unreadable */
        }
      }
    }
    this.cache = m;
    return m;
  }

  /** 外部（撤销 / 回收站恢复）改了文件后调用 */
  invalidate(): void {
    this.cache = null;
  }

  private write(n: Note): void {
    fs.mkdirSync(this.root, { recursive: true });
    const f = this.fileOf(n.id);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serializeNote(n), { mode: 0o600 });
    fs.renameSync(tmp, f);
    this.load().set(n.id, n);
  }

  create(i: { title: string; body: string; tags?: string[] }): Note {
    const t = this.now();
    const n: Note = {
      id: `n${t.toString(36)}${randomBytes(3).toString('hex')}`,
      title: i.title.trim().slice(0, 200) || tr('electron.common.untitled'),
      tags: cleanTags(i.tags),
      created: t,
      updated: t,
      body: i.body.slice(0, MAX_BODY),
    };
    this.write(n);
    return n;
  }

  get(id: string): Note | null {
    if (!NOTE_ID.test(id)) return null;
    return this.load().get(id) ?? null;
  }

  update(
    id: string,
    p: { title?: string; body?: string; append?: string; tags?: string[] },
  ): { before: Note; after: Note } {
    const before = this.get(id);
    if (!before)
      throw Object.assign(new Error(tr('electron.common.note-not-found')), { code: 'not_found' });
    const body =
      p.append !== undefined
        ? `${before.body.replace(/\s*$/, '')}\n\n${p.append}`
        : (p.body ?? before.body);
    const after: Note = {
      ...before,
      title: p.title?.trim() ? p.title.trim().slice(0, 200) : before.title,
      tags: p.tags ? cleanTags(p.tags) : before.tags,
      body: body.slice(0, MAX_BODY),
      updated: this.now(),
    };
    this.write(after);
    return { before, after };
  }

  /** 原样写回（撤销 update 用） */
  restore(n: Note): void {
    this.write(n);
  }

  list(i: { tag?: string; limit?: number; offset?: number } = {}): NoteMeta[] {
    const tag = i.tag ? norm(i.tag.replace(/^#/, '')) : null;
    return [...this.load().values()]
      .filter((n) => !tag || n.tags.some((t) => norm(t) === tag))
      .sort((a, b) => b.updated - a.updated)
      .slice(i.offset ?? 0, (i.offset ?? 0) + (i.limit ?? 50))
      .map(({ body: _b, ...m }) => m);
  }

  search(query: string, limit = 20): NoteHit[] {
    const out: NoteHit[] = [];
    for (const n of this.load().values()) {
      const r = scoreNote(n, query);
      if (r) {
        const { body: _b, ...m } = n;
        out.push({ ...m, ...r });
      }
    }
    return out.sort((a, b) => b.score - a.score || b.updated - a.updated).slice(0, limit);
  }

  forget(id: string): void {
    this.load().delete(id);
  }
}
