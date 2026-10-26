/**
 * 调试追踪（docs/design/unified-gateway.md §14）：用量面板的「调试模式」打开时，主进程在配置里给出
 * traceDir，网关把每个请求的请求体、发给上游的请求体和响应正文写到 `<traceDir>/<时间>-<客户端>.json`。
 *
 * - Key、客户端令牌、Authorization 等一律脱敏：已知的密钥值（配置里的 Key 与令牌）按原文替换，
 *   再按隐私模式的共用规则（privacy/rules）、常见格式（sk-…、Bearer …、AIza…）和敏感字段名兜底；
 * - 文件 0600、目录 0700；超过 24 小时的文件自动删除（写入时顺带清理，主进程关掉开关后也会清理）。
 * 纯 Node，不依赖 Electron。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { GatewayConfig } from './config';
import { mergeSpans, ruleSpans } from './privacy/rules';

/** 追踪文件保留时长 */
export const TRACE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 单个正文最多记录的字符数（超出截断，避免一次长对话写出几十 MB） */
export const TRACE_MAX_BODY_CHARS = 2_000_000;
/** 两次自动清理之间的最短间隔 */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

const REDACTED = '[REDACTED]';

/** 值整体要脱敏的字段名（请求头与 JSON 字段，大小写不敏感）。注意不能误伤 max_tokens 之类 */
const SECRET_FIELD =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-goog-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|session[-_]?token|token|secret|client[-_]?secret|password|private[-_]?key|device[-_]?code|user[-_]?code|auth(?:orization)?[-_]?code|code[-_]?verifier)$/i;

/** 文本里常见的密钥格式 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b(xai|gsk|ghp|gho|github_pat|glpat|hf)_[A-Za-z0-9_]{12,}/g,
  /([?&](?:key|api_key|access_token|refresh_token|token|code|code_verifier|client_secret)=)[^&\s"']+/gi,
  // Nomi 自己的令牌按前缀认（客户端令牌 nomi-gw-、标签令牌 nomi-tab-）：不依赖知道原文（§8.4）
  /\bnomi-(?:gw|tab)-[A-Za-z0-9_-]{6,}/g,
  // 设备码登录给出的一次性用户码（如 ABCD-EFGH）出现在 "code" 字样之后时
  /((?:user|device)[ _-]?code["']?\s*[:=]\s*["']?)[A-Z0-9]{4}-[A-Z0-9]{4,}/gi,
];

/**
 * 把文本里的密钥替换成 [REDACTED]。`secrets` 是已知的密钥原文（配置里的 Key 与客户端令牌），
 * 优先按原文替换；太短的（< 6 个字符）不按原文替换，避免把普通单词也抹掉。
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join(REDACTED);
  // 与隐私模式共用的规则（私钥块、各家 key 前缀、JWT、连接串密码…），再按下面追踪自己的格式兜底
  const spans = ruleSpans(out);
  if (spans.length) {
    let acc = '';
    let at = 0;
    for (const sp of mergeSpans(spans)) {
      acc += out.slice(at, sp.start) + REDACTED;
      at = sp.end;
    }
    out = acc + out.slice(at);
  }
  for (const re of SECRET_PATTERNS)
    out = out.replace(re, (m, p1: string | undefined) =>
      typeof p1 === 'string' && (/^[?&]/.test(p1) || /code/i.test(p1))
        ? `${p1}${REDACTED}`
        : typeof p1 === 'string' && /^Bearer$/i.test(p1)
          ? `${p1} ${REDACTED}`
          : REDACTED,
    );
  return out;
}

/** 深拷贝并脱敏：敏感字段名整体替换，其余字符串按 redactText 处理 */
export function redactJson(v: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 64) return '[…]';
  if (typeof v === 'string') return redactText(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactJson(x, secrets, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      out[k] =
        SECRET_FIELD.test(k) && (typeof x === 'string' || typeof x === 'number')
          ? REDACTED
          : redactJson(x, secrets, depth + 1);
    return out;
  }
  return v;
}

/** 请求头脱敏（数组值合并成一个字符串） */
export function redactHeaders(
  h: Record<string, string | string[] | undefined>,
  secrets: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    const s = Array.isArray(v) ? v.join(', ') : String(v);
    out[k] = SECRET_FIELD.test(k) ? REDACTED : redactText(s, secrets);
  }
  return out;
}

/** 配置里全部的密钥原文：各供应商的 Key、客户端令牌、旧版共享令牌 */
export function secretsOf(cfg: GatewayConfig): string[] {
  const out: string[] = [];
  for (const p of cfg.providers) for (const k of p.keys) if (k.value) out.push(k.value);
  for (const c of Object.values(cfg.clients)) if (c?.token) out.push(c.token);
  if (cfg.legacyToken) out.push(cfg.legacyToken);
  // 长的先替换：一个密钥是另一个的前缀时不留半截
  return out.sort((a, b) => b.length - a.length);
}

/** 客户端输出相对上游原文的差异里，每一边最多保留的事件数 */
const DIFF_MAX_BLOCKS = 200;

/** SSE 按空行切成事件；不是 SSE 的整段当作一个块 */
function blocksOf(text: string): string[] {
  if (!/\r?\n\r?\n/.test(text)) return text.trim() ? [text.trim()] : [];
  return text
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

/**
 * 客户端收到的输出相对上游原文的差异（§8.4 体积约定：上游存全文，下一层只存差异）：
 * 被网关新增 / 改写的事件（added）与被丢弃 / 改写前的事件（dropped），按多重集合比较；没有差异返回 null。
 */
export function traceDiff(
  upstream: string,
  client: string,
): { added: string[]; dropped: string[]; addedTotal: number; droppedTotal: number } | null {
  if (upstream === client) return null;
  const count = new Map<string, number>();
  for (const b of blocksOf(upstream)) count.set(b, (count.get(b) ?? 0) + 1);
  const added: string[] = [];
  for (const b of blocksOf(client)) {
    const n = count.get(b) ?? 0;
    if (n > 0) count.set(b, n - 1);
    else added.push(b);
  }
  const dropped: string[] = [];
  for (const [b, n] of count) for (let i = 0; i < n; i++) dropped.push(b);
  if (!added.length && !dropped.length) return null;
  return {
    added: added.slice(0, DIFF_MAX_BLOCKS),
    dropped: dropped.slice(0, DIFF_MAX_BLOCKS),
    addedTotal: added.length,
    droppedTotal: dropped.length,
  };
}

const clip = (s: string) =>
  s.length > TRACE_MAX_BODY_CHARS
    ? `${s.slice(0, TRACE_MAX_BODY_CHARS)}…[truncated ${s.length - TRACE_MAX_BODY_CHARS} chars]`
    : s;

/**
 * 删除 dir 里超过 maxAgeMs 的追踪文件（只动 .json）。返回删除的个数；目录不存在时返回 0。
 */
export function pruneTraces(dir: string, now = Date.now(), maxAgeMs = TRACE_MAX_AGE_MS): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const n of names) {
    // 正式追踪是 .json；崩溃留下的 .*.tmp 也清掉，避免目录堆积
    if (!n.endsWith('.json') && !n.endsWith('.tmp')) continue;
    const f = path.join(dir, n);
    try {
      if (now - fs.statSync(f).mtimeMs > maxAgeMs) {
        fs.rmSync(f, { force: true });
        removed++;
      }
    } catch {
      /* 并发删除等，忽略 */
    }
  }
  return removed;
}

const lastPrune = new Map<string, number>();

/** 文件名用的时间戳：2026-10-21T08-15-30-123Z */
export const traceStamp = (ts: number) => new Date(ts).toISOString().replace(/[:.]/g, '-');

interface TraceAttempt {
  provider: string;
  key?: string;
  wire: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  status?: number;
  error?: string;
}

/**
 * 一个请求的追踪记录。网关在请求各阶段调用它，结束时 finish() 写盘（异步，失败只记日志）。
 */
export class RequestTrace {
  private readonly secrets: string[];
  private readonly attempts: TraceAttempt[] = [];
  private requestHeaders: Record<string, string> = {};
  private requestBody: unknown;
  private responseText = '';
  private clientText = '';
  private responseStatus: number | undefined;
  private done = false;
  /** 追踪 id：写进响应头 x-nomi-trace-id、请求日志与文件名，三层记录据此关联（§8.3） */
  readonly id: string;

  constructor(
    private readonly dir: string,
    cfg: GatewayConfig,
    private readonly meta: { client: string; ingress: string; path: string; startedAt: number },
    private readonly opts: {
      logger?: { warn(m: string, d?: unknown): void };
      now?: () => number;
      /** 测试注入 */
      id?: string;
    } = {},
  ) {
    this.secrets = secretsOf(cfg);
    this.id = opts.id ?? randomUUID().replace(/-/g, '').slice(0, 12);
  }

  request(headers: Record<string, string | string[] | undefined>, body: unknown): void {
    this.requestHeaders = redactHeaders(headers, this.secrets);
    this.requestBody = body;
  }

  attempt(a: TraceAttempt): void {
    this.attempts.push(a);
  }

  /** 最近一次尝试的结果（状态码 / 上游错误正文） */
  attemptResult(status: number, error?: string): void {
    const last = this.attempts[this.attempts.length - 1];
    if (!last) return;
    last.status = status;
    if (error) last.error = error;
  }

  /** 上游原始响应（全文） */
  response(status: number, chunk: string): void {
    this.responseStatus = status;
    if (this.responseText.length <= TRACE_MAX_BODY_CHARS) this.responseText += chunk;
  }

  /** 网关实际写给客户端的输出（落盘时只存相对上游原文的差异） */
  client(chunk: string): void {
    if (this.clientText.length <= TRACE_MAX_BODY_CHARS) this.clientText += chunk;
  }

  /** 写盘；返回写出的文件路径（测试用），失败返回 null */
  async finish(result: {
    status: number;
    ms: number;
    attempts: number;
    usage?: unknown;
    error?: string;
    notes?: string[];
  }): Promise<string | null> {
    if (this.done) return null;
    this.done = true;
    const s = this.secrets;
    const diff = traceDiff(this.responseText, this.clientText);
    const doc = {
      version: 2,
      traceId: this.id,
      client: this.meta.client,
      ingress: this.meta.ingress,
      path: redactText(this.meta.path, s),
      startedAt: new Date(this.meta.startedAt).toISOString(),
      ...result,
      error: result.error ? redactText(result.error, s) : undefined,
      request: {
        headers: this.requestHeaders,
        body: redactJson(this.requestBody, s),
      },
      upstream: this.attempts.map((a) => ({
        ...a,
        url: redactText(a.url, s),
        headers: a.headers ? redactHeaders(a.headers, s) : undefined,
        body: redactJson(a.body, s),
        error: a.error ? clip(redactText(a.error, s)) : undefined,
      })),
      response: {
        status: this.responseStatus,
        body: clip(redactText(this.responseText, s)),
      },
      // 给客户端的输出：与上游原文相同就不存；否则只存被新增 / 丢弃的事件
      clientOutput: diff
        ? {
            ...diff,
            added: diff.added.map((b) => clip(redactText(b, s))),
            dropped: diff.dropped.map((b) => clip(redactText(b, s))),
          }
        : 'same-as-upstream',
    };
    const safeClient = this.meta.client.replace(/[^A-Za-z0-9_-]/g, '_');
    const base = `${traceStamp(this.meta.startedAt)}-${safeClient}-${this.id}`;
    const data = JSON.stringify(doc, null, 2);
    try {
      await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
      let file = '';
      for (let i = 0; i < 20; i++) {
        file = path.join(this.dir, i ? `${base}-${i + 1}.json` : `${base}.json`);
        // 先写完整内容到临时文件，再用 link 独占发布：读者永远看不到半截 JSON。
        // （直接 writeFile 到最终路径时，readdir 能先看到文件、read 却读到不完整内容。）
        const tmp = `${file}.${process.pid}.${i}.tmp`;
        try {
          await fs.promises.writeFile(tmp, data, { mode: 0o600 });
          await fs.promises.link(tmp, file);
          await fs.promises.unlink(tmp).catch(() => undefined);
          break;
        } catch (e) {
          await fs.promises.unlink(tmp).catch(() => undefined);
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i === 19) throw e;
        }
      }
      this.maybePrune();
      return file;
    } catch (e) {
      this.opts.logger?.warn('gateway trace write failed', { error: (e as Error).message });
      return null;
    }
  }

  private maybePrune(): void {
    const now = (this.opts.now ?? Date.now)();
    if (now - (lastPrune.get(this.dir) ?? 0) < PRUNE_INTERVAL_MS) return;
    lastPrune.set(this.dir, now);
    pruneTraces(this.dir, now);
  }
}

/** 配置了 traceDir 才追踪 */
export function startTrace(
  cfg: GatewayConfig,
  meta: { client: string; ingress: string; path: string; startedAt: number },
  logger?: { warn(m: string, d?: unknown): void },
): RequestTrace | null {
  return cfg.traceDir ? new RequestTrace(cfg.traceDir, cfg, meta, { logger }) : null;
}
