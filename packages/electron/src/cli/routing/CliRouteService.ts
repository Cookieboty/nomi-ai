/**
 * 本地路由：把 Claude Code / Codex 的原生请求转到真实上游，并按档案 apiFormat 做协议转换。
 * 默认监听 127.0.0.1:18721（仅本机）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';

import { guardedHandle } from '../../security/guardedIpc';
import {
  emptySniffed,
  hasTokens,
  mergeUsage,
  SseUsageTap,
  usageFromObject,
} from '../../usage/sniff';
import { getUsageService } from '../../usage/UsageService';
import { writePrivateFile } from '../../utils/privateFile';
import {
  type ClaudeApiFormat,
  type CodexApiFormat,
  type CliApiFormat,
  formatNeedsRouting,
} from '../formats';

import {
  createStreamConverter,
  jsonToJson,
  jsonToSse,
  type DownstreamStreamFormat,
  type UpstreamStreamFormat,
} from './stream';
import {
  chatCompletionsResponseToMessages,
  chatCompletionsResponseToResponses,
  geminiResponseToMessages,
  messagesResponseToChatCompletions,
  messagesResponseToResponses,
  messagesToChatCompletions,
  messagesToGemini,
  messagesToResponses,
  responsesResponseToMessages,
  responsesToChatCompletions,
  responsesToMessages,
  chatCompletionsToMessages,
} from './transforms';

/** 流式转换方向；null 表示上游与下游同协议，原样透传字节 */
export type StreamPlan = { from: UpstreamStreamFormat; to: DownstreamStreamFormat } | null;

export interface RouteSettings {
  /** 总开关 */
  enabled: boolean;
  host: string;
  port: number;
  /** 接管 Claude Code → 写本地地址 */
  claude: boolean;
  /** 接管 Codex → 写本地地址 */
  codex: boolean;
}

export interface RouteUpstream {
  kind: 'claude' | 'codex';
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: CliApiFormat;
}

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

const DEFAULTS: RouteSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: 18721,
  claude: false,
  codex: false,
};

/** 本地路由只允许监听回环地址：0.0.0.0 / 局域网 / 外网地址会把用户的上游密钥暴露给别的机器 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

export function isLoopbackHost(host: unknown): host is (typeof LOOPBACK_HOSTS)[number] {
  return typeof host === 'string' && (LOOPBACK_HOSTS as readonly string[]).includes(host);
}

/** URL 里的主机段：IPv6 需要方括号 */
function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Host 头校验（防 DNS 重绑定）：主机名必须是回环名，端口必须是本服务监听的端口。
 * 浏览器里的恶意页面经重绑定访问 127.0.0.1 时，Host 仍是攻击者的域名，在这里被拒绝。
 */
export function isAllowedHostHeader(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const m = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim());
  if (!m) return false;
  const name = m[1]!.replace(/^\[|\]$/g, '').toLowerCase();
  if (!isLoopbackHost(name)) return false;
  return m[2] === undefined ? port === 80 : Number(m[2]) === port;
}

function bearerOrApiKey(req: http.IncomingMessage): string {
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x) return x;
  const a = req.headers.authorization;
  if (typeof a === 'string') return a.replace(/^Bearer\s+/i, '');
  return '';
}

function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

/** Responses 请求里 type=custom 的工具名 */
export function customToolNames(body: unknown): Set<string> {
  const tools = (body as { tools?: unknown } | null)?.tools;
  const out = new Set<string>();
  if (!Array.isArray(tools)) return out;
  for (const t of tools as Array<{ type?: unknown; name?: unknown }>) {
    if (t && t.type === 'custom' && typeof t.name === 'string') out.add(t.name);
  }
  return out;
}

/** 同协议时 JSON→SSE 回退所用的方向 */
function nativeStreamPlan(
  kind: 'claude' | 'codex',
  url: string,
): { from: UpstreamStreamFormat; to: DownstreamStreamFormat } {
  if (kind === 'claude') return { from: 'messages', to: 'messages' };
  return url.includes('chat/completions')
    ? { from: 'chat', to: 'chat' }
    : { from: 'responses', to: 'responses' };
}

/** 上游地址的主机名（用量面板里作为「供应商」显示） */
function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host || undefined;
  } catch {
    return undefined;
  }
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

function joinUrl(base: string, p: string): string {
  const b = trimSlash(base);
  if (/^https?:\/\//i.test(p)) return p;
  return `${b}${p.startsWith('/') ? p : `/${p}`}`;
}

export class CliRouteService {
  private settings: RouteSettings;
  private server: http.Server | null = null;
  /** 当前打开的连接（含 keep-alive 空闲连接）：停止时要一并销毁，否则 server.close() 迟迟不返回 */
  private readonly sockets = new Set<Socket>();
  private readonly settingsPath: string;
  private readonly tokenPath: string;
  private token: string;
  private resolveUpstream: (kind: 'claude' | 'codex') => RouteUpstream | null;

  constructor(
    private readonly d: {
      root: string;
      logger: Logger;
      resolveUpstream: (kind: 'claude' | 'codex') => RouteUpstream | null;
    },
  ) {
    this.settingsPath = path.join(d.root, 'routing.json');
    this.tokenPath = path.join(d.root, 'routing.token');
    this.resolveUpstream = d.resolveUpstream;
    this.settings = this.load();
    this.token = this.loadOrCreateToken();
  }

  /**
   * 本地路由令牌：首次生成后以 0600 落盘并复用（CLI 配置里写的就是它，重启应用不应让已配置的 CLI 失效）。
   * 请求必须带上它（Claude 的 x-api-key / Codex 的 Authorization: Bearer），否则 401。
   */
  private loadOrCreateToken(): string {
    try {
      const raw = fs.readFileSync(this.tokenPath, 'utf8').trim();
      if (/^nomi-route-[0-9a-f]{48}$/.test(raw)) return raw;
    } catch {
      /* 首次运行 */
    }
    const token = `nomi-route-${randomBytes(24).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
      writePrivateFile(this.tokenPath, token);
    } catch (e) {
      this.d.logger.warn('route token persist failed', e);
    }
    return token;
  }

  /** 写进 CLI 配置的本地路由令牌（仅主进程内部使用，不经 IPC 返回给渲染进程） */
  authToken(): string {
    return this.token;
  }

  private load(): RouteSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) as Partial<RouteSettings>;
      const merged = { ...DEFAULTS, ...raw };
      // 历史配置里若有非回环地址，回退到默认，不再对外监听
      if (!isLoopbackHost(merged.host)) merged.host = DEFAULTS.host;
      return merged;
    } catch {
      return { ...DEFAULTS };
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8');
  }

  getSettings(): RouteSettings & { listening: boolean; listenUrl: string | null } {
    return {
      ...this.settings,
      listening: Boolean(this.server?.listening),
      listenUrl: this.listenUrl(),
    };
  }

  listenUrl(): string | null {
    if (!this.server?.listening) return null;
    return `http://${urlHost(this.settings.host)}:${this.settings.port}`;
  }

  /** CLI 配置应写入的 base（含 /v1 视应用而定） */
  cliBaseUrl(kind: 'claude' | 'codex'): string | null {
    if (!this.settings.enabled || !this.settings[kind]) return null;
    const base = `http://${urlHost(this.settings.host)}:${this.settings.port}`;
    return kind === 'codex' ? `${base}/v1` : base;
  }

  setSettings(
    patch: Partial<RouteSettings>,
  ): RouteSettings & { listening: boolean; listenUrl: string | null } {
    if (patch.host !== undefined && patch.host !== '' && !isLoopbackHost(patch.host)) {
      throw new Error(`本地路由只能监听 127.0.0.1 / localhost / ::1（收到 ${String(patch.host)}）`);
    }
    this.settings = {
      ...this.settings,
      ...patch,
      host: typeof patch.host === 'string' && patch.host ? patch.host : this.settings.host,
      port:
        typeof patch.port === 'number' && patch.port > 0 && patch.port < 65536
          ? Math.floor(patch.port)
          : this.settings.port,
    };
    this.save();
    if (this.settings.enabled) {
      void this.start().catch((e) => this.d.logger.warn('route start failed', e));
    } else {
      this.stop();
    }
    return this.getSettings();
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    this.stop();
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.settings.port, this.settings.host, () => resolve());
    });
    this.d.logger.info('cli route listening', this.listenUrl());
  }

  /** 停止监听并断开所有连接（含 keep-alive 空闲连接与进行中的流） */
  stop(): void {
    const server = this.server;
    this.server = null;
    if (server) {
      try {
        server.close();
      } catch {
        /* */
      }
      try {
        server.closeAllConnections?.();
      } catch {
        /* */
      }
    }
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  dispose(): void {
    this.stop();
  }

  private detectKind(req: http.IncomingMessage, url: string): 'claude' | 'codex' | null {
    // Codex 走 /v1/responses 或 /v1/chat/completions；Claude 走 /v1/messages 或 /messages
    if (url.includes('/responses') || url.includes('/chat/completions')) return 'codex';
    if (url.includes('/messages') || url.includes('/v1/messages')) return 'claude';
    // Gemini path used when Claude upstream is gemini
    if (url.includes(':generateContent') || url.includes('/models/')) return 'claude';
    const via = String(req.headers['x-nomi-cli'] ?? '');
    if (via === 'claude' || via === 'codex') return via;
    return null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    // 用量与计费：记录经过本地路由的请求（响应里的 usage；取不到就不记，避免编造）
    let track: { kind: 'claude' | 'codex'; startedAt: number; up: RouteUpstream } | null = null;
    let sniffed = emptySniffed();
    try {
      // 防 DNS 重绑定：Host 必须是回环名 + 本服务端口
      if (!isAllowedHostHeader(req.headers.host, this.settings.port)) {
        sendJson(res, 421, { error: 'misdirected request: invalid Host header' });
        return;
      }
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        sendJson(res, 200, { ok: true, service: 'nomi-cli-route' });
        return;
      }
      if (!tokenEquals(bearerOrApiKey(req), this.token)) {
        sendJson(res, 401, {
          error:
            'unauthorized: missing or wrong local route token (re-activate the provider profile in Nomi to refresh the CLI config)',
        });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const url = req.url ?? '/';
      const kind = this.detectKind(req, url);
      if (!kind) {
        sendJson(res, 404, { error: 'unknown route path' });
        return;
      }
      if (!this.settings.enabled || !this.settings[kind]) {
        sendJson(res, 503, { error: `routing disabled for ${kind}` });
        return;
      }
      const up = this.resolveUpstream(kind);
      if (!up) {
        sendJson(res, 502, { error: `no active ${kind} provider` });
        return;
      }
      if (formatNeedsRouting(kind, up.apiFormat) === false && kind === 'claude') {
        // native passthrough still ok via route
      }
      track = { kind, startedAt: Date.now(), up };
      getUsageService()?.routeBegin(kind);
      const body = await readJson(req);
      const wantsStream =
        Boolean(body) && typeof body === 'object' && (body as { stream?: unknown }).stream === true;
      const { upstreamUrl, requestBody, responseTransform, stream } = this.plan(
        kind,
        up,
        url,
        body,
        wantsStream,
      );
      // Codex 的自由文本工具：模型回调时需还原为 custom_tool_call
      const convOpts = {
        model: up.model,
        customTools:
          kind === 'codex' && !url.includes('chat/completions') ? customToolNames(body) : undefined,
      };
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: wantsStream ? 'text/event-stream' : 'application/json',
      };
      if (up.apiKey) {
        if (up.apiFormat === 'anthropic_messages' && kind === 'codex') {
          headers['x-api-key'] = up.apiKey;
          headers['anthropic-version'] = '2023-06-01';
        } else if (up.apiFormat === 'gemini_generate_content') {
          // Gemini 原生 API 使用 x-goog-api-key 鉴权
          headers['x-goog-api-key'] = up.apiKey;
        } else if (kind === 'claude' && up.apiFormat === 'anthropic_messages') {
          headers['x-api-key'] = up.apiKey;
          headers['anthropic-version'] = '2023-06-01';
        } else {
          headers.Authorization = `Bearer ${up.apiKey}`;
        }
      }
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      const upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: abort.signal,
      });
      const isSse = (upstreamRes.headers.get('content-type') ?? '').includes('text/event-stream');
      if (wantsStream && upstreamRes.ok && isSse && upstreamRes.body) {
        const tap = new SseUsageTap();
        await this.pipeStream(upstreamRes.body, res, stream, convOpts, tap);
        sniffed = tap.end();
        return;
      }
      const text = await upstreamRes.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      if (upstreamRes.ok) {
        const part = usageFromObject(parsed);
        if (part) sniffed = mergeUsage(sniffed, part);
      }
      if (!upstreamRes.ok) {
        res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
        res.end(typeof parsed === 'string' ? text : JSON.stringify(parsed));
        return;
      }
      if (wantsStream && parsed && typeof parsed === 'object') {
        // 客户端要流式、上游却回了普通 JSON：合成目标协议的完整 SSE
        const plan = stream ?? nativeStreamPlan(kind, url);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(jsonToSse(plan.from, plan.to, parsed, convOpts));
        return;
      }
      if (stream) {
        // 跨协议非流式：经中间事件重建目标 JSON，保留工具调用、停止原因与用量
        const r = jsonToJson(stream.from, stream.to, parsed, convOpts);
        sendJson(res, r.status, r.body);
        return;
      }
      sendJson(res, 200, responseTransform(parsed));
    } catch (e) {
      this.d.logger.warn('cli route error', e);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (track) {
        const t = track;
        getUsageService()?.routeEnd(t.kind, {
          startedAt: t.startedAt,
          provider: hostOf(t.up.baseUrl),
          model: t.up.model,
          usage: hasTokens(sniffed) ? sniffed : null,
        });
      }
    }
  }

  /** 上游 SSE → 下游 SSE：按需逐片做协议转换，并在上游中断时补发错误事件 */
  private async pipeStream(
    body: ReadableStream<Uint8Array>,
    res: http.ServerResponse,
    stream: StreamPlan,
    convOpts: { model?: string; customTools?: ReadonlySet<string> },
    tap?: SseUsageTap,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const conv = stream ? createStreamConverter(stream.from, stream.to, convOpts) : null;
    const decoder = new TextDecoder();
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (res.destroyed) return;
        const text = tap || conv ? decoder.decode(value, { stream: true }) : '';
        tap?.push(text);
        if (!conv) {
          res.write(Buffer.from(value));
          continue;
        }
        const outChunk = conv.push(text);
        if (outChunk) res.write(outChunk);
      }
      if (conv) {
        const tail = conv.push(decoder.decode()) + conv.end();
        if (tail) res.write(tail);
      }
    } catch (e) {
      if (res.destroyed) return;
      this.d.logger.warn('cli route stream interrupted', e);
      if (conv) res.write(conv.fail(e instanceof Error ? e.message : String(e)));
    } finally {
      reader.releaseLock();
      if (!res.destroyed) res.end();
    }
  }

  private plan(
    kind: 'claude' | 'codex',
    up: RouteUpstream,
    reqUrl: string,
    body: unknown,
    wantsStream = false,
  ): {
    upstreamUrl: string;
    requestBody: unknown;
    responseTransform: (u: unknown) => unknown;
    stream: StreamPlan;
  } {
    const base = trimSlash(up.baseUrl);
    /** Chat Completions 流默认不带 usage，显式请求 */
    const withChatUsage = (b: unknown): unknown =>
      wantsStream && b && typeof b === 'object'
        ? { ...(b as object), stream: true, stream_options: { include_usage: true } }
        : b;
    if (kind === 'claude') {
      const fmt = up.apiFormat as ClaudeApiFormat;
      if (fmt === 'anthropic_messages') {
        return {
          upstreamUrl: joinUrl(base.includes('/v1') ? base : `${base}/v1`, '/messages'),
          requestBody: body,
          responseTransform: (u) => u,
          stream: null,
        };
      }
      if (fmt === 'openai_chat_completions') {
        return {
          upstreamUrl: joinUrl(base, '/chat/completions'),
          requestBody: withChatUsage(messagesToChatCompletions(body, up.model)),
          responseTransform: chatCompletionsResponseToMessages,
          stream: { from: 'chat', to: 'messages' },
        };
      }
      if (fmt === 'openai_responses') {
        return {
          upstreamUrl: joinUrl(base, '/responses'),
          requestBody: messagesToResponses(body, up.model),
          responseTransform: responsesResponseToMessages,
          stream: { from: 'responses', to: 'messages' },
        };
      }
      // gemini
      const model = (up.model || 'gemini-pro').replace(/^models\//, '');
      // 仅填域名时补上 API 版本段
      const gBase = /\/v1(beta|alpha)?\d*(\/|$)/.test(base) ? base : `${base}/v1beta`;
      return {
        upstreamUrl: wantsStream
          ? joinUrl(gBase, `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`)
          : joinUrl(gBase, `/models/${encodeURIComponent(model)}:generateContent`),
        requestBody: messagesToGemini(body),
        responseTransform: geminiResponseToMessages,
        stream: { from: 'gemini', to: 'messages' },
      };
    }
    // codex
    const fmt = up.apiFormat as CodexApiFormat;
    if (fmt === 'openai_responses') {
      return {
        upstreamUrl: joinUrl(base, '/responses'),
        requestBody: body,
        responseTransform: (u) => u,
        stream: null,
      };
    }
    if (fmt === 'openai_chat_completions') {
      // Codex 原生发 responses；若请求已是 chat 则透传转换路径
      const isChat = reqUrl.includes('chat/completions');
      return {
        upstreamUrl: joinUrl(base, '/chat/completions'),
        requestBody: isChat ? body : withChatUsage(responsesToChatCompletions(body, up.model)),
        responseTransform: isChat ? (u) => u : chatCompletionsResponseToResponses,
        stream: isChat ? null : { from: 'chat', to: 'responses' },
      };
    }
    // anthropic_messages
    return {
      upstreamUrl: joinUrl(base.includes('/v1') ? base : `${base}/v1`, '/messages'),
      requestBody: reqUrl.includes('chat/completions')
        ? chatCompletionsToMessages(body, up.model)
        : responsesToMessages(body, up.model),
      responseTransform: reqUrl.includes('chat/completions')
        ? messagesResponseToChatCompletions
        : messagesResponseToResponses,
      stream: reqUrl.includes('chat/completions')
        ? { from: 'messages', to: 'chat' }
        : { from: 'messages', to: 'responses' },
    };
  }

  address(): AddressInfo | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a : null;
  }

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) =>
      guardedHandle(ch, fn, { owner: 'CliRouteService' });
    handle('ai:cli-route:state', () => this.getSettings());
    handle('ai:cli-route:set', (p) => this.setSettings((p ?? {}) as Partial<RouteSettings>));
    handle('ai:cli-route:start', () => this.start().then(() => this.getSettings()));
    handle('ai:cli-route:stop', () => {
      this.stop();
      return this.getSettings();
    });
  }
}

let inst: CliRouteService | null = null;
export function initCliRouteService(
  d: ConstructorParameters<typeof CliRouteService>[0],
): CliRouteService {
  inst = new CliRouteService(d);
  return inst;
}
export function getCliRouteService(): CliRouteService | null {
  return inst;
}
