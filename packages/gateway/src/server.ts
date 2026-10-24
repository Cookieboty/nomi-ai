/**
 * 网关 HTTP 服务（docs/design/unified-gateway.md §5.1、§10）：
 * 鉴权（客户端令牌）→ 按路径识别入口协议 → 解析候选 → 逐个尝试上游 → 同协议透传 / 跨协议转换。
 * 纯 Node：既能跑在 Electron utilityProcess 里，也能直接在 Vitest 里起服务测试。
 */
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { Affinity, sessionKey } from './affinity';
import { bridgeJson, bridgeMode, createBridge } from './bridge';
import { ResponsesCanonicalizer } from './canonical/responses';
import {
  clientHooksOf,
  ClientConformer,
  clientSpecOf,
  legacyClientOf,
  type ModelResolution,
} from './clients/index';
import { peekCommit, type PeekResult } from './commit';
import type { ClientId, GatewayConfig } from './config';
import { CLIENT_IDS } from './config';
import { coolsDown, Cooldowns, type KeyStatusEvent } from './cooldown';
import { customToolNames, isCustomToolRefusal } from './customTools';
import {
  clientStatusOf,
  errorResponse,
  kindOfStatus,
  upstreamAuthMessage,
  upstreamMessage,
} from './errors';
import { applyRequestFixes, serverToolError, toolLimitError } from './fixes';
import { ingressFromPath, type Ingress } from './ingress';
import type { Wire } from './ir';
import { classifyFailure, Learner, type LearnEvent } from './learn';
import { limitsOf, Limiter } from './limits';
import { modelsBody } from './models';
import { UnsupportedParamError } from './models/rules/request/index';
import { isAllowedHostHeader, urlHost } from './net/loopback';
import { checkUpstream, UpstreamBlockedError, type LookupAll } from './net/upstreamGuard';
import { ProviderStage, specOf } from './providers/index';
import { stagedResponse } from './providers/stream';
import { hasSealedReasoning, isReasoningRejection, stripSealedReasoning } from './reasoning';
import { responseFixOptions } from './responseFixes';
import {
  BINDING_RETRY_AFTER_S,
  BindingTable,
  hashTabToken,
  isTabToken,
  type TabBinding,
} from './route/binding';
import { alternateWire, resolveCandidates, type Candidate } from './route/resolve';
import { SessionTable } from './sessions';
import type { StreamUsage } from './stream';
import { passthroughFail } from './stream/passthrough';
import {
  candidateIsReasoning,
  resolveFirstByteBudgetMs,
  resolveFirstByteTimeoutMs,
  resolveStreamIdleTimeoutMs,
  FIRST_BYTE_TIMEOUT_MS,
  NON_STREAM_FIRST_BYTE_TIMEOUT_MS,
  REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS,
  FIRST_BYTE_BUDGET_MS,
  NON_STREAM_FIRST_BYTE_BUDGET_MS,
  STREAM_IDLE_TIMEOUT_MS,
} from './timeouts';
import { calibratedCount, measuredInputTokens, recordUsage, sessionKeyOf } from './tokens';
import { startTrace, type RequestTrace } from './trace';
import { upstreamBody, upstreamHeaders, upstreamUrl } from './upstream';
import { usageOfJson, UsageTap } from './usageTap';

export {
  FIRST_BYTE_TIMEOUT_MS,
  NON_STREAM_FIRST_BYTE_TIMEOUT_MS,
  REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS,
  FIRST_BYTE_BUDGET_MS,
  NON_STREAM_FIRST_BYTE_BUDGET_MS,
  STREAM_IDLE_TIMEOUT_MS,
  candidateIsReasoning,
  resolveFirstByteTimeoutMs,
  resolveFirstByteBudgetMs,
  resolveStreamIdleTimeoutMs,
};

export const GATEWAY_VERSION = '1';

/** 每个请求最多尝试的候选数（§11.1） */
const MAX_ATTEMPTS = 4;
/** 每个请求因运行时学习而重试的上限（计入 MAX_ATTEMPTS） */
const MAX_LEARN_RETRIES = 2;
/**
 * 响应头：实际服务这次请求的模型（`供应商/模型`）。回退到别的候选时与请求模型不同，
 * Nomi 对话据此记账（#97；ai-runtime 的 NOMI_SERVED_MODEL_HEADER 与此一致）
 */
export const SERVED_MODEL_HEADER = 'x-nomi-served-model';

export type GatewayClient = ClientId | 'legacy';

export interface UsageEvent {
  client: GatewayClient;
  ingress: Wire;
  wire?: Wire;
  provider?: string;
  keyId?: string;
  model?: string;
  status: number;
  usage: StreamUsage;
  startedAt: number;
  ms: number;
  /** 拿到上游 2xx 响应头的时间（相对 startedAt，ms）；失败的请求没有 */
  firstByteMs?: number;
  attempts: number;
  error?: string;
  /** 网关对请求做的修正（§12.7.3，如省略了图片、压低了输出上限），用量面板展示提示 */
  notes?: string[];
  /** 诊断追踪 id（只有开着诊断日志时才有，§8.3）：与追踪文件、响应头 x-nomi-trace-id 对应 */
  traceId?: string;
  /** 带标签令牌的请求：所属标签与进程代次（§6.7） */
  tabId?: string;
  generation?: number;
  /** 模型是怎么解析出来的（显式 / 档位 / 辅助 / 绑定 / 未知名 / 默认） */
  resolved?: ModelResolution;
}

export interface GatewayHooks {
  onUsage?: (e: UsageEvent) => void;
  /** 运行时学到的东西（主进程持久化，§7.4） */
  onLearn?: (e: LearnEvent) => void;
  /** Key × wire 的状态变化（401/403 → auth，429 → limited，之后恢复 → ok；§11.1），主进程记 lastError */
  onKeyStatus?: (e: KeyStatusEvent) => void;
  logger?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  lookupAll?: LookupAll;
  /** 流式首字节超时（默认 30s）；测试可缩短 */
  firstByteTimeoutMs?: number;
  /** 非流式首字节超时（默认 5min）；思考模型另见 reasoningNonStream… */
  nonStreamFirstByteTimeoutMs?: number;
  /** 非流式 + reasoning 模型首字节超时（默认 10min） */
  reasoningNonStreamFirstByteTimeoutMs?: number;
  /** 流式：首字节前换候选总预算（默认 60s） */
  firstByteBudgetMs?: number;
  /** 非流式：首字节前换候选总预算（默认 15min） */
  nonStreamFirstByteBudgetMs?: number;
  /** 流式空闲超时（默认 180s） */
  streamIdleTimeoutMs?: number;
  /** 冷却与亲和用的时钟（测试注入假时钟） */
  now?: () => number;
  /** 标签绑定表（§6.7）：由网关进程入口持有，配置重启网关时不丢；不给时网关自己建一个 */
  bindings?: BindingTable;
  /** 未知标签令牌等绑定的时长（默认 2 秒；测试缩短） */
  bindingWaitMs?: number;
}

function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extra?: Record<string, string>,
) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...extra,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
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

/** 令牌可以放在 x-api-key、Authorization: Bearer、x-goog-api-key 或 ?key= 里 */
function presentedTokens(req: http.IncomingMessage, url: URL): string[] {
  const out: string[] = [];
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x) out.push(x);
  const a = req.headers.authorization;
  if (typeof a === 'string' && a) out.push(a.replace(/^Bearer\s+/i, ''));
  const g = req.headers['x-goog-api-key'];
  if (typeof g === 'string' && g) out.push(g);
  const q = url.searchParams.get('key');
  if (q) out.push(q);
  return out;
}

/** 旧版共享令牌的客户端身份：按客户端规格的 legacy 规则（入口路径、User-Agent）推断（§10.2、§5.5） */
function legacyClient(ingress: Ingress | null, ua: string): ClientId | null {
  return legacyClientOf(ingress?.wire ?? null, ua) as ClientId | null;
}

/** 请求的身份：客户端，以及带标签令牌时的绑定 */
interface Identity {
  client: GatewayClient;
  binding?: TabBinding;
}

type Attempt =
  | {
      kind: 'response';
      res: Response;
      cand: Candidate;
      notes?: string[];
      /** 供应商预处理（§6.3）：套在了 res 上；心跳计数在这里 */
      stage?: ProviderStage;
    }
  | {
      kind: 'failed';
      status: number;
      message: string;
      retryable: boolean;
      cand: Candidate;
      /** 上游错误体与本次发出的请求体（运行时学习分类用，§7.4） */
      text?: string;
      sent?: unknown;
      /** 上游真实返回的状态码（冷却按它判断，§11.1） */
      upstreamStatus?: number;
      /** 连接失败或首字节前超时 */
      network?: boolean;
      /** 上游的 Retry-After 原文（冷却时长；最终错误原样转发，§9.6） */
      retryAfter?: string;
    };

export class GatewayServer {
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();

  private readonly learner: Learner;
  private readonly cooldowns: Cooldowns;
  /** 标签令牌的绑定（§6.7）：主进程经 worker 消息登记，网关回应答 */
  readonly bindings: BindingTable;
  /** 按 (供应商, Key) 的并发与每分钟请求数（§6.11.3） */
  private readonly limiter: Limiter;
  private readonly affinity: Affinity;
  private readonly sessions: SessionTable;

  constructor(
    private cfg: GatewayConfig,
    private readonly hooks: GatewayHooks = {},
  ) {
    const now = hooks.now ?? Date.now;
    this.limiter = new Limiter(now);
    this.bindings = hooks.bindings ?? new BindingTable();
    this.cooldowns = new Cooldowns((e) => {
      this.hooks.logger?.info('gateway key status', e);
      this.hooks.onKeyStatus?.(e);
    }, now);
    this.affinity = new Affinity(now);
    this.sessions = new SessionTable(cfg.sessionsFile ?? null, now);
    this.learner = new Learner((e) => {
      this.hooks.logger?.info('gateway learned', e);
      this.hooks.onLearn?.(e);
    });
  }

  /** 换新配置：进行中的请求继续用各自拿到的旧快照 */
  update(cfg: GatewayConfig): void {
    this.cfg = cfg;
  }

  get config(): GatewayConfig {
    return this.cfg;
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.once('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.cfg.port, this.cfg.host, () => resolve());
    });
    this.hooks.logger?.info('gateway listening', this.listenUrl());
  }

  stop(): void {
    this.sessions.flush();
    const s = this.server;
    this.server = null;
    try {
      s?.close();
      s?.closeAllConnections?.();
    } catch {
      /* 已关闭 */
    }
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
  }

  address(): AddressInfo | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a : null;
  }

  listenUrl(): string | null {
    const a = this.address();
    return a ? `http://${urlHost(this.cfg.host)}:${a.port}` : null;
  }

  /**
   * 认身份：客户端级令牌、标签令牌（§6.7）、旧版共享令牌。
   * 标签令牌格式正确但还没登记时短暂等待绑定；等不到返回 'unbound'（503，不用 401）。
   */
  private async identify(
    req: http.IncomingMessage,
    url: URL,
  ): Promise<Identity | 'unbound' | null> {
    const tokens = presentedTokens(req, url);
    for (const id of CLIENT_IDS) {
      const t = this.cfg.clients[id]?.token;
      if (t && tokens.some((x) => tokenEquals(x, t))) return { client: id };
    }
    const tab = tokens.find(isTabToken);
    if (tab) {
      const binding =
        this.bindings.get(hashTabToken(tab)) ??
        (await this.bindings.lookup(tab, this.hooks.bindingWaitMs));
      if (!binding) return 'unbound';
      const client = binding.client as ClientId;
      return CLIENT_IDS.includes(client) ? { client, binding } : null;
    }
    const legacy = this.cfg.legacyToken;
    if (legacy && tokens.some((x) => tokenEquals(x, legacy))) return { client: 'legacy' };
    return null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cfg = this.cfg;
    const port = this.address()?.port ?? cfg.port;
    if (!isAllowedHostHeader(req.headers.host, port)) {
      sendJson(res, 421, { error: 'misdirected request: invalid Host header' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      sendJson(res, 200, { ok: true, service: 'nomi-gateway', version: GATEWAY_VERSION });
      return;
    }
    // 不设 CORS，浏览器发来的跨站请求一律拒绝
    if (req.headers.origin) {
      sendJson(res, 403, { error: 'browser requests are not allowed' });
      return;
    }
    const ingress = ingressFromPath(url.pathname);
    const who = await this.identify(req, url);
    if (who === 'unbound') {
      // 新进程的第一个请求比绑定先到、且等了一会儿还没到：让 CLI 稍后重试（不是 401，§6.11.5）
      const e = errorResponse(
        ingress?.wire ?? 'chat',
        'overloaded',
        'Nomi 网关：这个标签的会话还没准备好，请稍后重试',
      );
      sendJson(res, e.status, e.body, { 'Retry-After': String(BINDING_RETRY_AFTER_S) });
      return;
    }
    const client = who?.client ?? null;
    if (!client) {
      const e = errorResponse(
        ingress?.wire ?? 'chat',
        'auth',
        'Nomi 网关：缺少或错误的客户端令牌（请在 Nomi 里重新打开这个标签）',
      );
      sendJson(res, e.status, e.body);
      return;
    }
    if (req.method === 'GET' && /\/models\/?$/.test(url.pathname)) {
      const format = url.pathname.startsWith('/v1beta')
        ? 'gemini'
        : req.headers['x-api-key'] && !req.headers.authorization
          ? 'anthropic'
          : 'openai';
      sendJson(res, 200, modelsBody(cfg, format));
      return;
    }
    if (req.method !== 'POST' || !ingress) {
      sendJson(res, 404, { error: `unknown route: ${req.method} ${url.pathname}` });
      return;
    }
    await this.proxy(req, res, cfg, client, ingress, who?.binding);
  }

  private async proxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cfg: GatewayConfig,
    client: GatewayClient,
    ingress: Ingress,
    binding?: TabBinding,
  ): Promise<void> {
    const startedAt = Date.now();
    /** 每个用量事件都带上的标签与解析信息 */
    const tag: Partial<UsageEvent> = binding
      ? { tabId: binding.tabId, generation: binding.generation }
      : {};
    const fail = (status: number, message: string, retryAfter?: string) => {
      const e = errorResponse(ingress.wire, kindOfStatus(status, message), message);
      // 上游给了 Retry-After 时原样转发，CLI 自带的重试会照着等（§9.6）
      if (!res.headersSent)
        sendJson(res, e.status, e.body, retryAfter ? { 'Retry-After': retryAfter } : undefined);
      // 提交点之前已经发过 SSE 响应头（保活）：用入口协议的错误事件结束（§6.11.2）
      else if (sseOpen && !res.destroyed) res.end(sseFailure(ingress.wire, message));
      else res.end();
    };
    let sseOpen = false;
    const keepAlive = () => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(200, SSE_HEADERS);
      res.write(': keepalive\n\n');
      sseOpen = true;
    };
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      fail(400, 'Nomi 网关：请求体不是合法的 JSON');
      return;
    }
    // 调试模式（§14）：配置里有 traceDir 才记录正文，结束时脱敏写盘
    const trace = startTrace(
      cfg,
      { client, ingress: ingress.wire, path: req.url ?? '', startedAt },
      this.hooks.logger,
    );
    trace?.request(req.headers, body);
    if (trace) tapClientOutput(res, trace);
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const requested =
      ingress.wire === 'gemini'
        ? (ingress.model ?? '')
        : typeof b.model === 'string'
          ? b.model
          : '';
    const resolveAs =
      client === 'legacy' ? legacyClient(ingress, String(req.headers['user-agent'] ?? '')) : client;
    const r = resolveCandidates(cfg, resolveAs, requested, ingress.wire, binding);
    if (!r.ok) {
      fail(r.status, r.message);
      return;
    }
    if (r.resolution) tag.resolved = r.resolution.how;
    // 路由计划的影子模式（§6.9.4）：新计划与现有规则选的协议不同就写日志，观察一个版本再切换
    const plan = r.candidates[0]?.plan;
    if (plan?.legacy && plan.legacy !== plan.upstream)
      this.hooks.logger?.info('gateway route plan (shadow) differs', {
        model: r.candidates[0]!.publicModel,
        ingress: ingress.wire,
        current: plan.legacy,
        planned: plan.upstream,
        why: plan.why,
        losses: plan.losses,
      });
    /** 模型解析的备注（未知模型名按标签主模型处理等），并进这次请求的备注 */
    const resolveNotes = r.resolution?.note ? [r.resolution.note] : [];
    const wantsStream = ingress.wire === 'gemini' ? Boolean(ingress.stream) : b.stream === true;
    if (ingress.countTokens) {
      await this.countTokens(res, cfg, ingress, body, r.candidates[0]!);
      return;
    }

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const errors: string[] = [];
    let attempts = 0;
    let last: Attempt | null = null;
    let firstByteMs: number | undefined;
    /** 成功的那个候选占着的并发名额：写完响应再释放 */
    let held: (() => void) | null = null;
    // 排序：被短期压制的（§7.4）和冷却中的（§11.1）排到后面，亲和的排到第一（§11.2）。
    // 学习触发的重试（换 wire / 去掉字段）插到队首，每个请求最多 2 次（§7.4）
    const session = sessionKey(ingress.wire, req.headers, body, client);
    // 会话归属（§11.4）只认 CLI 给的会话标识，不用内容哈希
    const owner = sessionKey(ingress.wire, req.headers, body, client, { hashFallback: false });
    let stripAll = false;
    const queue = this.ordered(
      this.withSuppression(cfg, r.candidates, ingress.wire),
      session ? this.affinity.get(session) : null,
    );
    let learnRetries = 0;
    while (queue.length && attempts < MAX_ATTEMPTS) {
      if (
        Date.now() - startedAt > resolveFirstByteBudgetMs(wantsStream, this.hooks) ||
        abort.signal.aborted
      )
        break;
      const cand = queue.shift()!;
      attempts++;
      // 同协议透传：历史里的加密推理和签名只在上一轮是同一 (供应商, Key, 协议) 时保留（§9.3）
      const keep =
        !stripAll &&
        ingress.wire === cand.wire &&
        this.sessions.canKeep(owner, {
          providerId: cand.provider.id,
          keyId: cand.key.id,
          wire: cand.wire,
        });
      const sendBody =
        ingress.wire === cand.wire && !keep ? stripSealedReasoning(ingress.wire, body) : body;
      // 并发与每分钟请求数（§6.11.3）：排队期间给客户端发保活；等不到就换下一个候选（不冷却这个 Key）
      const release = await this.limiter.acquire(
        `${cand.provider.id}\u0000${cand.key.id}`,
        limitsOf(cand.provider, cand.key),
        { ...(wantsStream ? { onWaiting: keepAlive } : {}), signal: abort.signal },
      );
      if (!release) {
        last = {
          kind: 'failed',
          status: 429,
          message: '这个 Key 的并发 / 每分钟请求数已满，排队超时',
          retryable: true,
          cand,
        };
        errors.push(`${cand.provider.name}·${cand.key.name ?? cand.key.id}: ${last.message}`);
        continue;
      }
      last = await this.attempt(
        cfg,
        resolveAs,
        req,
        ingress,
        cand,
        sendBody,
        wantsStream,
        abort.signal,
        trace,
        binding?.effort,
      );
      // 提交点（§6.11.2）：流式响应等到第一个内容事件才算成功；之前的错误事件还能换候选
      if (last.kind === 'response' && wantsStream && isSseResponse(last.res)) {
        let got = last;
        // 供应商预处理（§6.3）在提交点之前：伪装成正文增量的保活不能触发提交
        const spec = specOf(cand.provider, cand.wire);
        if (ProviderStage.needed(spec)) {
          const stage = new ProviderStage(spec, cand.wire);
          const status = got.res.status;
          const onRaw = trace ? (t: string) => trace.response(status, t) : undefined;
          got = { ...got, res: stagedResponse(got.res, stage, onRaw), stage };
        }
        const peek = await peekCommit(got.res, cand.wire, {
          waitingMs: COMMIT_KEEPALIVE_MS,
          onWaiting: keepAlive,
        }).catch((e: unknown): PeekResult => ({
          kind: 'error',
          status: 502,
          message: `上游中断（${(e as Error).message}）`,
        }));
        if (peek.kind === 'commit') last = { ...got, res: peek.res };
        else {
          trace?.attemptResult(200, peek.message);
          last = {
            kind: 'failed',
            status: peek.status,
            message: `上游在开始输出前报错：${peek.message}`,
            retryable: !abort.signal.aborted,
            cand,
            ...(peek.upstreamStatus ? { upstreamStatus: peek.upstreamStatus } : {}),
          };
        }
      }
      if (last.kind !== 'response') release();
      else held = release;
      if (last.kind === 'response') {
        firstByteMs = Date.now() - startedAt;
        this.learner.success(cand);
        this.cooldowns.success(cand);
        if (session)
          this.affinity.set(session, { providerId: cand.provider.id, keyId: cand.key.id });
        this.sessions.record(owner, {
          providerId: cand.provider.id,
          keyId: cand.key.id,
          wire: cand.wire,
          model: cand.publicModel,
        });
        break;
      }
      // 带着保留下来的推理被拒：剥掉全部重试一次，这个会话之后都不再保留（§9.3 被拒后的兜底）
      if (
        keep &&
        isReasoningRejection(last.upstreamStatus ?? last.status, last.text ?? last.message) &&
        learnRetries < MAX_LEARN_RETRIES &&
        hasSealedReasoning(ingress.wire, body)
      ) {
        this.sessions.markNoKeep(owner);
        stripAll = true;
        learnRetries++;
        errors.push(`${cand.provider.name}·${cand.wire}: ${last.message}`);
        queue.unshift(cand);
        continue;
      }
      errors.push(
        `${cand.provider.name}·${cand.key.name ?? cand.key.id}·${cand.wire}: ${last.message}`,
      );
      if (coolsDown(last) && !abort.signal.aborted)
        this.cooldowns.fail(cand, {
          upstreamStatus: last.upstreamStatus,
          retryAfter: last.retryAfter,
          message: last.message,
        });
      const hint =
        last.text !== undefined
          ? this.learner.failure(
              cand,
              classifyFailure(last.status, last.text, last.sent, { applied: cand.rectify }),
            )
          : null;
      const retry =
        hint && learnRetries < MAX_LEARN_RETRIES
          ? 'dropParam' in hint
            ? { ...cand, dropParams: [...(cand.dropParams ?? []), hint.dropParam] }
            : 'rectify' in hint
              ? { ...cand, rectify: [...(cand.rectify ?? []), hint.rectify] }
              : alternateWire(cfg, cand, ingress.wire, [hint.excludeWire])
          : null;
      if (retry) {
        learnRetries++;
        queue.unshift(retry);
        continue;
      }
      // 学习类错误换不了 wire 时也换下一个候选；其余按 §11.1 的规则
      // Responses 上游不接受 custom 工具：转成函数工具重试一次，记下来之后都用转换模式（§11.3）
      if (
        last.text !== undefined &&
        cand.wire === 'responses' &&
        !cand.customToolsAsFunctions &&
        learnRetries < MAX_LEARN_RETRIES &&
        isCustomToolRefusal(last.status, last.text, last.sent)
      ) {
        this.learner.customToolsRefused(cand);
        learnRetries++;
        queue.unshift({ ...cand, customToolsAsFunctions: true });
        continue;
      }
      // 模型在这个供应商不存在：同供应商的其它 Key 也没有，跳到回退的供应商
      if (last.status === 404) {
        const others = queue.filter((c) => c.provider.id !== cand.provider.id);
        queue.splice(0, queue.length, ...others);
        if (others.length) continue;
      }
      if (!last.retryable && !hint) break;
    }
    if (!last || last.kind === 'failed') {
      // 提交前的状态码矩阵（§6.11.5）：上游 401 / 403 不能原样给 CLI（会被当成要重新登录）
      const raw = last?.status ?? 502;
      const status = clientStatusOf(raw);
      let message =
        errors.length > 1
          ? `Nomi 网关：所有候选都失败了 —— ${errors.join('；')}`
          : (last?.message ?? 'Nomi 网关：没有可用的候选');
      if ((raw === 401 || raw === 403) && errors.length <= 1)
        message = upstreamAuthMessage(raw, message);
      fail(status, message, last?.retryAfter);
      void trace?.finish({ status, ms: Date.now() - startedAt, attempts, error: message });
      this.hooks.onUsage?.({
        client,
        ingress: ingress.wire,
        ...(last
          ? {
              wire: last.cand.wire,
              provider: last.cand.provider.id,
              keyId: last.cand.key.id,
              model: last.cand.publicModel,
            }
          : {}),
        status,
        usage: {},
        startedAt,
        ms: Date.now() - startedAt,
        attempts,
        error: message,
        ...(resolveNotes.length ? { notes: resolveNotes } : {}),
        ...(trace ? { traceId: trace.id } : {}),
        ...tag,
      });
      return;
    }
    const { res: up, cand, stage } = last;
    // 模型解析的备注、请求修正（attempt）之后再追加响应修正（respond，§11.3）
    const notes = [...resolveNotes, ...(last.notes ?? [])];
    let usage: StreamUsage;
    try {
      usage = await this.respond(
        res,
        ingress,
        cand,
        up,
        body,
        wantsStream,
        abort,
        notes,
        trace,
        stage,
        resolveAs,
      );
    } finally {
      held?.();
    }
    void trace?.finish({
      status: up.status,
      ms: Date.now() - startedAt,
      attempts,
      usage,
      ...(notes.length ? { notes } : {}),
    });
    // 用真实用量校准 count_tokens（§10.3）
    recordUsage({
      sessionKey: sessionKeyOf(ingress.wire, req.headers, body),
      providerId: cand.provider.id,
      model: cand.upstreamModel,
      wire: ingress.wire,
      body,
      inputTokens: measuredInputTokens(cand.wire, usage),
    });
    this.hooks.onUsage?.({
      client,
      ingress: ingress.wire,
      wire: cand.wire,
      provider: cand.provider.id,
      keyId: cand.key.id,
      model: cand.publicModel,
      status: up.status,
      usage,
      startedAt,
      ms: Date.now() - startedAt,
      ...(firstByteMs !== undefined ? { firstByteMs } : {}),
      attempts,
      ...(notes.length ? { notes } : {}),
      ...(trace ? { traceId: trace.id } : {}),
      ...tag,
    });
  }

  /**
   * 被短期压制的 (供应商, Key, wire)：同一个 Key 先换别的协议，原候选排到最后（仍可用，§7.4）。
   */
  private withSuppression(cfg: GatewayConfig, cands: Candidate[], ingress: Wire): Candidate[] {
    const head: Candidate[] = [];
    const tail: Candidate[] = [];
    for (const c of cands) {
      if (!this.learner.isSuppressed(c)) {
        head.push(c);
        continue;
      }
      const alt = alternateWire(cfg, c, ingress, [c.wire]);
      if (alt && !this.learner.isSuppressed(alt)) head.push(alt);
      tail.push(c);
    }
    return [...head, ...tail];
  }

  /**
   * 冷却中的 (供应商, Key, wire) 排到队尾（没有别的可用时照样尝试，§11.1）；
   * 会话上次成功的 (供应商, Key) 不在冷却期就排到第一（§11.2）。其余保持原顺序。
   */
  private ordered(
    cands: Candidate[],
    sticky: { providerId: string; keyId: string } | null,
  ): Candidate[] {
    const first: Candidate[] = [];
    const rest: Candidate[] = [];
    const cooling: Candidate[] = [];
    for (const c of cands) {
      if (this.cooldowns.isCooling(c)) cooling.push(c);
      else if (sticky && c.provider.id === sticky.providerId && c.key.id === sticky.keyId)
        first.push(c);
      else rest.push(c);
    }
    return [...first, ...rest, ...cooling];
  }

  /** 一次上游尝试；拿到 2xx 响应头就算成功（之后不再换候选） */
  private async attempt(
    cfg: GatewayConfig,
    client: string | null,
    req: http.IncomingMessage,
    ingress: Ingress,
    cand: Candidate,
    body: unknown,
    wantsStream: boolean,
    signal: AbortSignal,
    trace?: RequestTrace | null,
    bindingEffort?: string,
  ): Promise<Attempt> {
    const base = cand.provider.urls[cand.wire]!;
    const target = upstreamUrl(cand.wire, base, cand.upstreamModel, { stream: wantsStream });
    try {
      await checkUpstream(target, {
        allowedPrivateHosts: cfg.allowedPrivateHosts,
        selfPort: this.address()?.port ?? cfg.port,
        lookupAll: this.hooks.lookupAll,
      });
    } catch (e) {
      return {
        kind: 'failed',
        status: 400,
        message: (e as Error).message,
        retryable: e instanceof UpstreamBlockedError,
        cand,
      };
    }
    const notes: string[] = [];
    let sent: unknown;
    try {
      sent = upstreamBody(ingress.wire, cand, body, {
        stream: wantsStream,
        ingressModel: ingress.model,
        notes,
        client: client ?? undefined,
        ...(bindingEffort ? { bindingEffort } : {}),
      });
    } catch (e) {
      // 严格模式（§6.9.6）：模型不支持的参数直接报给用户，不换候选
      if (e instanceof UnsupportedParamError)
        return { kind: 'failed', status: 400, message: e.message, retryable: false, cand };
      throw e;
    }
    // 工具数超过供应商上限：不发请求，直接给出明确错误（下一个候选可能没有这个限制）
    const tooMany = toolLimitError(cand, sent);
    if (tooMany) return { kind: 'failed', status: 400, message: tooMany, retryable: true, cand };
    // 专门的联网搜索请求发给不支持服务端工具的上游：明确报错，不返回没有搜索结果的回答
    const noSearch = serverToolError(cand, ingress.wire, body);
    if (noSearch) return { kind: 'failed', status: 400, message: noSearch, retryable: true, cand };
    if (notes.length)
      this.hooks.logger?.info('gateway request fixes', { model: cand.publicModel, notes });
    // 只管到响应头为止：拿到响应后撤销，正文由流的空闲超时 / 用户取消管（#93）
    // 非流式时「首字节」= 整轮生成完才出头；思考模型用更长超时（见 timeouts.ts）
    const firstByte = new AbortController();
    const firstByteMs = resolveFirstByteTimeoutMs(
      wantsStream,
      candidateIsReasoning(cand),
      this.hooks,
    );
    const timer = setTimeout(() => firstByte.abort(), firstByteMs);
    const both = AbortSignal.any([signal, firstByte.signal]);
    const headers = upstreamHeaders(cand, {
      stream: wantsStream,
      clientHeaders: req.headers,
      sameWire: ingress.wire === cand.wire,
    });
    trace?.attempt({
      provider: cand.provider.name,
      key: cand.key.name ?? cand.key.id,
      wire: cand.wire,
      url: target,
      headers,
      body: sent,
    });
    let res: Response;
    try {
      res = await (this.hooks.fetchImpl ?? fetch)(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(sent),
        redirect: 'manual',
        signal: both,
      });
    } catch (e) {
      const timedOut = firstByte.signal.aborted && !signal.aborted;
      return {
        kind: 'failed',
        status: timedOut ? 504 : 502,
        message: timedOut ? '上游在首字节前超时' : `连接上游失败：${(e as Error).message}`,
        retryable: !signal.aborted,
        cand,
        network: !signal.aborted,
      };
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return { kind: 'response', res, cand, ...(notes.length ? { notes } : {}) };
    const text = await res.text().catch(() => '');
    const s = res.status;
    trace?.attemptResult(s, text);
    // §11.1：429 / 5xx / 529 / 401 / 403 换下一个候选；其余 4xx 不换（学习类错误由调用方另算）。
    // 重定向按网关错误（502）处理，换下一个候选，但不冷却
    const retryable = s === 429 || s >= 500 || s === 401 || s === 403 || (s >= 300 && s < 400);
    const retryAfter = res.headers.get('retry-after') ?? undefined;
    return {
      kind: 'failed',
      status: s >= 300 && s < 400 ? 502 : s,
      message: s >= 300 && s < 400 ? `上游返回重定向（${s}），网关不跟随` : upstreamMessage(text),
      retryable,
      cand,
      text,
      sent,
      upstreamStatus: s,
      ...(retryAfter ? { retryAfter } : {}),
    };
  }

  /** 把上游的 2xx 响应按入口协议写回客户端，返回用量；做了的响应修正追加到 notes（§11.3） */
  private async respond(
    res: http.ServerResponse,
    ingress: Ingress,
    cand: Candidate,
    up: Response,
    body: unknown,
    wantsStream: boolean,
    abort: AbortController,
    notes: string[] = [],
    trace?: RequestTrace | null,
    stage?: ProviderStage,
    client: string | null = null,
  ): Promise<StreamUsage> {
    res.setHeader(SERVED_MODEL_HEADER, cand.publicModel);
    // custom 工具转换模式（§11.3）：同协议也要走转换，回程把函数调用还原成 custom_tool_call
    const passthrough =
      bridgeMode(cand.wire, ingress.wire, cand.customToolsAsFunctions) === 'passthrough';
    const isSse = (up.headers.get('content-type') ?? '').includes('text/event-stream');
    const fixes = responseFixOptions(ingress.wire, cand, body, notes);
    const convOpts = {
      model: cand.publicModel,
      customTools: ingress.wire === 'responses' ? customToolNames(body) : undefined,
      fixes,
    };
    if (wantsStream && isSse && up.body) {
      // 提交点之前可能已经发过响应头与 SSE 注释保活（§6.11.2）
      if (!res.headersSent) res.writeHead(200, SSE_HEADERS);
      const spec = clientSpecOf(client);
      const tap = new UsageTap(cand.wire);
      // 协议桥（§6.5）：同协议按事件透传，只在修正触发时改事件；跨协议 / custom 工具转换：解码 → 修正 → 编码
      const bridge = createBridge({
        from: cand.wire,
        to: ingress.wire,
        mode: bridgeMode(cand.wire, ingress.wire, cand.customToolsAsFunctions),
        model: cand.publicModel,
        customTools: convOpts.customTools,
        fixes,
        ...(spec?.heartbeat ? { heartbeat: spec.heartbeat.kind } : {}),
      });
      // 客户端校验（§6.6）：严格客户端按规格再校验一次；宽松客户端不经过
      const conformer =
        spec && ClientConformer.needed(spec, clientHooksOf(client))
          ? new ClientConformer({ spec, wire: ingress.wire, notes })
          : null;
      const conform = (t: string) => (conformer && t ? conformer.push(t) : t);
      const decoder = new TextDecoder();
      const reader = up.body.getReader();
      const idleMs = resolveStreamIdleTimeoutMs(this.hooks);
      let idle: ReturnType<typeof setTimeout> | null = null;
      let idleFired = false;
      const arm = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          idleFired = true;
          abort.abort();
        }, idleMs);
      };
      try {
        arm();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          if (res.destroyed) return tap.usage;
          const text = decoder.decode(value, { stream: true });
          tap.push(text);
          // 有供应商预处理时上游原文已在预处理那一层记过（追踪存原始字节，§8.4）
          if (!stage) trace?.response(up.status, text);
          let out = bridge.push(text);
          // 供应商适配器丢掉了上游的保活：给客户端发一个心跳（§6.6）
          if (stage?.alive) {
            stage.alive = 0;
            out += bridge.alive();
          }
          // 背压（§6.11.4）：客户端读得慢时暂停读上游，等 drain；等待期间不算上游空闲
          out = conform(out);
          const ok = out ? res.write(out) : true;
          if (!ok) {
            if (idle) clearTimeout(idle);
            await drained(res);
            arm();
          }
          // 复读检测触发：错误事件已经写出，不再读上游
          if (bridge.stopped) break;
        }
        const rest = bridge.stopped ? '' : decoder.decode();
        tap.push(rest);
        const tail = conform(bridge.end(rest)) + (conformer?.end() ?? '');
        if (tail) res.write(tail);
        if (bridge.stopped) {
          if (idle) clearTimeout(idle);
          await reader.cancel().catch(() => undefined);
        }
      } catch (e) {
        if (!res.destroyed) {
          const msg = idleFired
            ? `Nomi 网关：上游 ${Math.round(idleMs / 1000)} 秒没有任何输出，已中断`
            : `Nomi 网关：上游中断（${(e as Error).message}）`;
          res.write(conform(bridge.fail(msg)) + (conformer?.end() ?? ''));
        }
      } finally {
        if (idle) clearTimeout(idle);
        reader.releaseLock();
        if (!res.destroyed) res.end();
      }
      return tap.end();
    }
    let text: string;
    // 非流式正文也要有上限：上游发完响应头后卡住（不发正文也不断开）时，不能让请求永远挂着。
    // 取非流式「整轮」超时（5 分钟 / 思考模型 10 分钟），超时即中断上游连接（abort 与上游 fetch 同一个 signal）
    const bodyMs = resolveFirstByteTimeoutMs(false, candidateIsReasoning(cand), this.hooks);
    let bodyTimedOut = false;
    const bodyTimer = setTimeout(() => {
      bodyTimedOut = true;
      abort.abort();
    }, bodyMs);
    try {
      text = await up.text();
    } catch (e) {
      // 非流式正文读到一半上游断开 / 超时：按入口协议回错误，不让请求挂着
      const msg = bodyTimedOut
        ? `Nomi 网关：上游响应正文 ${Math.max(1, Math.round(bodyMs / 1000))} 秒内没有读完，已中断`
        : `Nomi 网关：上游中断（${(e as Error).message}）`;
      const err = errorResponse(ingress.wire, kindOfStatus(502, msg), msg);
      if (!res.headersSent) sendJson(res, err.status, err.body);
      else res.end();
      return {};
    } finally {
      clearTimeout(bodyTimer);
    }
    trace?.response(up.status, text);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 原样返回 */
    }
    const usage = typeof parsed === 'object' ? usageOfJson(cand.wire, parsed) : {};
    // 非流式路径（§6.11.1）：跨协议与「要流式」都经 NormEvent 走同一套修复，同协议只做规范补全
    const out = bridgeJson(
      {
        from: cand.wire,
        to: ingress.wire,
        mode: passthrough ? 'passthrough' : 'convert',
        model: cand.publicModel,
        customTools: convOpts.customTools,
        fixes,
      },
      { status: up.status, contentType: up.headers.get('content-type'), text, parsed },
      wantsStream,
    );
    if (out.kind === 'sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(out.body);
    } else if (out.kind === 'raw') {
      res.writeHead(out.status, { 'Content-Type': out.contentType });
      res.end(out.body);
    } else sendJson(res, out.status, out.body);
    return usage;
  }

  /** count_tokens：上游是 Messages 时转发，否则（或上游不支持）本地估算（§10.1、§10.3） */
  private async countTokens(
    res: http.ServerResponse,
    cfg: GatewayConfig,
    ingress: Ingress,
    body: unknown,
    cand: Candidate,
  ): Promise<void> {
    if (ingress.wire === 'messages' && cand.wire === 'messages') {
      const target = upstreamUrl('messages', cand.provider.urls.messages!, cand.upstreamModel, {
        countTokens: true,
      });
      try {
        await checkUpstream(target, {
          allowedPrivateHosts: cfg.allowedPrivateHosts,
          selfPort: this.address()?.port ?? cfg.port,
          lookupAll: this.hooks.lookupAll,
        });
        const up = await (this.hooks.fetchImpl ?? fetch)(target, {
          method: 'POST',
          headers: upstreamHeaders(cand, { stream: false, clientHeaders: {}, sameWire: true }),
          body: JSON.stringify(
            applyRequestFixes(cand, { ...(body as object), model: cand.upstreamModel }),
          ),
          redirect: 'manual',
          // count_tokens 是轻量查询，不是整轮生成：用流式首字节的短超时，卡住就退回本地估算
          // （不要用非流式的 5/10 分钟，否则客户端先超时）
          signal: AbortSignal.timeout(resolveFirstByteTimeoutMs(true, false, this.hooks)),
        });
        if (up.ok) {
          sendJson(res, 200, await up.json());
          return;
        }
      } catch {
        /* 退回本地估算 */
      }
    }
    // 用同一会话最近的真实用量校准（§10.3）；res.req 是这次的入站请求
    const n = calibratedCount({
      sessionKey: sessionKeyOf(ingress.wire, res.req.headers, body),
      providerId: cand.provider.id,
      model: cand.upstreamModel,
      wire: ingress.wire,
      body,
    });
    sendJson(res, 200, ingress.wire === 'gemini' ? { totalTokens: n } : { input_tokens: n });
  }
}

export function createGateway(cfg: GatewayConfig, hooks: GatewayHooks = {}): GatewayServer {
  return new GatewayServer(cfg, hooks);
}

/** 诊断追踪响应头（§8.3） */
export const TRACE_ID_HEADER = 'x-nomi-trace-id';

/**
 * 追踪开着时：设好 x-nomi-trace-id 响应头，并旁路记录网关实际写给客户端的每一块输出
 * （之后只把相对上游原文的差异落盘）。不改写输出本身。
 */
function tapClientOutput(res: http.ServerResponse, trace: RequestTrace): void {
  res.setHeader(TRACE_ID_HEADER, trace.id);
  const text = (c: unknown) =>
    typeof c === 'string' ? c : c instanceof Uint8Array ? Buffer.from(c).toString('utf8') : '';
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
  (res as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => {
    trace.client(text(a[0]));
    return write(...a);
  };
  (res as unknown as { end: (...a: unknown[]) => http.ServerResponse }).end = (...a: unknown[]) => {
    if (typeof a[0] !== 'function') trace.client(text(a[0]));
    return end(...a);
  };
}

/** 流式响应头 */
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

/** 等客户端把写缓冲读走（drain），或连接关闭（§6.11.4） */
function drained(res: http.ServerResponse): Promise<void> {
  if (res.destroyed || !res.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/** 提交前等这么久还没有内容事件：先发响应头与一行 SSE 注释保持连接（§6.11.2） */
export const COMMIT_KEEPALIVE_MS = 3_000;

function isSseResponse(r: Response): boolean {
  return Boolean(r.body) && (r.headers.get('content-type') ?? '').includes('text/event-stream');
}

/** 已开始的 SSE 流里报错：入口协议的失败事件（Responses 补齐严格客户端要求的字段） */
function sseFailure(wire: Wire, message: string): string {
  const ev = passthroughFail(wire, message);
  if (wire !== 'responses') return ev;
  const c = new ResponsesCanonicalizer();
  return c.push(ev) + c.end();
}
