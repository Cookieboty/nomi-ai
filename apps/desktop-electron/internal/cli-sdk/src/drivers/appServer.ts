/**
 * app-server 会话驱动（Codex `codex app-server`，stdio JSON-RPC）。
 *
 * initialize → initialized；有会话 id 时 thread/resume；新会话的 thread/start 推迟到第一条消息
 * （预热不留下空会话）。每轮 turn/start（沙箱 / 审批 / 模型 / 档位按轮下发，不重启进程），
 * 以 turn/completed 结束；停止用 turn/interrupt（turn/start 的应答还没回来时等它回来再发）。
 * 审批请求（item/commandExecution|fileChange/requestApproval）变成会话事件。
 * 线程条目 → HarnessEvent 的映射由插件给（mapItem），驱动只处理正文增量、用量与错误。
 */
import { randomUUID } from 'node:crypto';

import { endChild, type ChildLike, type KillFn } from '../child';
import {
  EventHub,
  appendText,
  type SessionDriver,
  type StartResult,
  type TurnInput,
  type TurnResult,
} from '../driver';
import type { HarnessEvent, PermissionAnswer, SessionEvent } from '../events';
import {
  JsonRpcConnection,
  innermostMessage,
  type Json,
  type RpcConnectionOptions,
} from '../rpc/jsonrpc';

import {
  codexApprovalSummary,
  codexLastContext,
  codexTokenTotals,
  codexTurnUsage,
  type CodexTokenTotals,
} from './appServerItems';

const APPROVALS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);

export interface AppServerDriverOptions {
  child: ChildLike;
  rpc?: RpcConnectionOptions;
  kill?: KillFn;
  permissionIdPrefix?: string;
  clientInfo?: { name: string; title: string; version: string };
  /** 线程条目（item/started、item/completed）→ HarnessEvent；不给就不出工具事件 */
  mapItem?: (phase: 'started' | 'completed', item: Json) => HarnessEvent[];
  newId?: () => string;
}

interface AppTurn {
  localId: string;
  /** app-server 给的轮次 id（turn/start 应答） */
  serverId: string | null;
  started: Promise<void>;
  text: string;
  lastItem: string | null;
  totalsBefore: CodexTokenTotals | null;
  lastError: string | null;
  settled: boolean;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
}

export class AppServerDriver implements SessionDriver {
  readonly conn: JsonRpcConnection;
  private readonly hub = new EventHub<SessionEvent>();
  private readonly perms = new Map<string, (a: PermissionAnswer) => void>();
  private turn: AppTurn | null = null;
  private exited = false;
  threadId: string | null = null;
  /** 线程累计用量（thread/tokenUsage/updated） */
  totals: CodexTokenTotals | null = null;
  /** 最近一次请求的上下文占用与模型窗口 */
  context: { contextTokens?: number; contextWindow?: number } | null = null;

  constructor(private readonly o: AppServerDriverOptions) {
    this.conn = new JsonRpcConnection(
      o.child,
      {
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: (method, params) => this.onRequest(method, params),
      },
      o.rpc,
    );
    o.child.on('close', (code) => {
      this.exited = true;
      this.cancelPermissions();
      const turn = this.turn;
      this.turn = null;
      if (turn && !turn.settled) {
        turn.settled = true;
        turn.reject(new Error(turn.lastError ?? 'app-server process exited'));
      }
      this.hub.emit({ kind: 'health', state: 'exited', code });
      this.hub.end();
    });
  }

  get events(): AsyncIterable<SessionEvent> {
    return this.hub;
  }

  on(fn: (e: SessionEvent) => void): () => void {
    return this.hub.on(fn);
  }

  get sessionId(): string | null {
    return this.threadId;
  }

  get closed(): boolean {
    return this.exited || this.conn.isClosed;
  }

  get inTurn(): boolean {
    return this.turn !== null;
  }

  /** app-server 给这一轮的 id（turn/start 应答到达前为 null；停止要等它） */
  get currentTurnId(): string | null {
    return this.turn?.serverId ?? null;
  }

  private emit(event: HarnessEvent) {
    const turn = this.turn;
    if (turn) turn.text = appendText(turn.text, event);
    this.hub.emit({ kind: 'harness', event, ...(turn ? { turnId: turn.localId } : {}) });
  }

  private onNotification(method: string, params: Json) {
    if (method === 'thread/tokenUsage/updated' && params.threadId === this.threadId) {
      this.totals = codexTokenTotals(params.tokenUsage) ?? this.totals;
      const ctx = codexLastContext(params.tokenUsage);
      this.context = ctx ?? this.context;
      // 一轮进行中实时上报（自动压缩后的下一次请求会带上新的占用）
      if (this.turn && ctx?.contextTokens)
        this.emit({
          type: 'context',
          tokens: ctx.contextTokens,
          ...(ctx.contextWindow ? { window: ctx.contextWindow } : {}),
        });
      return;
    }
    const turn = this.turn;
    // 只认主线程：子代理线程的条目另有 collab 事件概括
    if (!turn || (params.threadId !== undefined && params.threadId !== this.threadId)) return;
    if (method === 'turn/started') {
      // thread/compact/start 的应答不带轮次 id：从 turn/started 取（停止、匹配 turn/completed 要用）
      const id = ((params.turn ?? {}) as { id?: unknown }).id;
      if (!turn.serverId && typeof id === 'string') turn.serverId = id;
      return;
    }
    if (method === 'item/agentMessage/delta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : null;
      const delta = typeof params.delta === 'string' ? params.delta : '';
      // 同一轮里的下一条消息：补段落分隔，避免两段流式文本粘在一起
      if (itemId !== turn.lastItem && turn.text.trim())
        this.emit({ type: 'text-delta', text: '\n\n' });
      turn.lastItem = itemId;
      if (delta) this.emit({ type: 'text-delta', text: delta });
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = (params.item ?? {}) as Json;
      // 上下文压缩（v2 ThreadItem contextCompaction）：开始 → 压缩中；完成 → 清状态，旧占用作废，
      // 等下一次 thread/tokenUsage/updated 带上压缩后的占用
      if (item.type === 'contextCompaction') {
        if (method === 'item/started') this.emit({ type: 'status', kind: 'compact' });
        else {
          this.emit({ type: 'status', kind: 'clear' });
          this.emit({ type: 'context', tokens: null });
        }
        return;
      }
      const evs = this.o.mapItem?.(method === 'item/started' ? 'started' : 'completed', item) ?? [];
      for (const ev of evs) this.emit(ev);
      return;
    }
    // 旧版只发 thread/compacted（已弃用，新版改发 contextCompaction 条目）：只清状态
    if (method === 'thread/compacted') {
      this.emit({ type: 'status', kind: 'clear' });
      return;
    }
    if (method === 'error') {
      const err = (params.error ?? {}) as { message?: unknown };
      const message = typeof err.message === 'string' ? err.message : 'app-server error';
      if (params.willRetry === true)
        this.emit({ type: 'status', kind: 'reconnect', text: message });
      else turn.lastError = message;
      return;
    }
    if (method === 'turn/completed') {
      const done = (params.turn ?? {}) as { id?: unknown; status?: unknown; error?: unknown };
      if (turn.serverId && done.id !== turn.serverId) return;
      this.finish(turn, done);
    }
  }

  private finish(turn: AppTurn, done: { id?: unknown; status?: unknown; error?: unknown }) {
    if (this.turn === turn) this.turn = null;
    this.cancelPermissions();
    if (turn.settled) return;
    turn.settled = true;
    const status = typeof done.status === 'string' ? done.status : 'completed';
    const err = done.error as { message?: unknown } | null | undefined;
    const turnUsage = codexTurnUsage(turn.totalsBefore, this.totals);
    const usage = turnUsage && this.context ? { ...turnUsage, ...this.context } : turnUsage;
    // turn/completed 可能先于 turn/start 的应答处理（serverId 还没写上）：用它带的 id
    const cliTurnId = turn.serverId ?? (typeof done.id === 'string' ? done.id : null);
    turn.resolve({
      turnId: turn.localId,
      stopReason: status,
      text: turn.text,
      sessionId: this.threadId,
      ...(cliTurnId ? { cliTurnId } : {}),
      ...(status === 'failed'
        ? {
            error: (typeof err?.message === 'string' && err.message) || turn.lastError || undefined,
          }
        : {}),
      ...(usage && status === 'completed' ? { usage } : {}),
      raw: done,
    });
  }

  private async onRequest(method: string, params: Json): Promise<unknown> {
    if (!APPROVALS.has(method)) throw new Error(`unsupported client method ${method}`);
    const id = `${this.o.permissionIdPrefix ?? 'codex-perm-'}${(this.o.newId ?? randomUUID)()}`;
    const answer = await new Promise<PermissionAnswer>((resolve) => {
      this.perms.set(id, resolve);
      this.hub.emit({
        kind: 'permission',
        id,
        request: { summary: codexApprovalSummary(method, params), method },
        ...(this.turn ? { turnId: this.turn.localId } : {}),
      });
    });
    this.perms.delete(id);
    const decision =
      'optionId' in answer
        ? /^reject|^decline|^deny/.test(answer.optionId)
          ? 'decline'
          : 'accept'
        : answer.decision === 'cancel'
          ? 'cancel'
          : answer.decision === 'allow'
            ? 'accept'
            : 'decline';
    return { decision };
  }

  respondPermission(id: string, answer: PermissionAnswer): boolean {
    const p = this.perms.get(id);
    if (!p) return false;
    p(answer);
    return true;
  }

  hasPermission(id: string): boolean {
    return this.perms.has(id);
  }

  private cancelPermissions() {
    for (const p of [...this.perms.values()]) p({ decision: 'cancel' });
  }

  async start(o: {
    cwd: string;
    resumeId?: string | null;
    signal?: AbortSignal;
  }): Promise<StartResult> {
    const opts = o.signal ? { signal: o.signal } : {};
    const init = await this.conn.request<{ userAgent?: unknown } | null>(
      'initialize',
      {
        clientInfo: this.o.clientInfo ?? { name: 'nomi', title: 'Nomi', version: '1' },
        capabilities: null,
      },
      opts,
    );
    this.conn.notify('initialized', {});
    if (o.resumeId) {
      const r = await this.conn.request<{ thread?: { id?: string } } | null>(
        'thread/resume',
        { threadId: o.resumeId, cwd: o.cwd },
        opts,
      );
      this.threadId = r?.thread?.id ?? o.resumeId;
    }
    this.hub.emit({ kind: 'health', state: 'ready' });
    return {
      sessionId: this.threadId,
      ...(o.resumeId ? { resumed: true } : {}),
      ...(typeof init?.userAgent === 'string' ? { version: init.userAgent } : {}),
      capabilities: { loadSession: true, images: true },
    };
  }

  /** 还没有线程时新建（第一条消息之前） */
  async ensureThread(cwd: string): Promise<string> {
    if (this.threadId) return this.threadId;
    const r = await this.conn.request<{ thread?: { id?: string } } | null>('thread/start', { cwd });
    this.threadId = r?.thread?.id ?? null;
    if (!this.threadId) throw new Error('app-server returned no thread');
    return this.threadId;
  }

  /**
   * 发起一轮：结束时（turn/completed）按 status 返回 completed / interrupted / failed，不抛错；
   * turn/start 本身失败、进程退出才 reject。params 里放 cwd、沙箱 / 审批策略、model、effort。
   */
  send(input: TurnInput): Promise<TurnResult> {
    const threadId = this.threadId;
    if (!threadId) return Promise.reject(new Error('app-server thread not started'));
    return this.startTurn('turn/start', {
      threadId,
      input: input.blocks ?? [{ type: 'text', text: input.text, text_elements: [] }],
      ...(input.params ?? {}),
    });
  }

  /**
   * 手动压缩上下文：thread/compact/start（应答为空对象）。服务端把它当作一轮（turn/started →
   * contextCompaction 条目 → turn/completed），结束方式与 send 相同；轮次 id 从 turn/started 取。
   */
  compact(): Promise<TurnResult> {
    const threadId = this.threadId;
    if (!threadId) return Promise.reject(new Error('app-server thread not started'));
    return this.startTurn('thread/compact/start', { threadId });
  }

  private startTurn(method: string, params: Json): Promise<TurnResult> {
    if (this.turn) return Promise.reject(new Error('previous turn still running'));
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((r) => (markStarted = r));
    return new Promise<TurnResult>((resolve, reject) => {
      const turn: AppTurn = {
        localId: (this.o.newId ?? randomUUID)(),
        serverId: null,
        started,
        text: '',
        lastItem: null,
        totalsBefore: this.totals,
        lastError: null,
        settled: false,
        resolve,
        reject,
      };
      this.turn = turn;
      this.conn.request<{ turn?: { id?: string } } | null>(method, params).then(
        (r) => {
          turn.serverId = r?.turn?.id ?? turn.serverId;
          markStarted();
        },
        (e: unknown) => {
          markStarted();
          if (this.turn === turn) this.turn = null;
          if (turn.settled) return;
          turn.settled = true;
          reject(new Error(innermostMessage(e instanceof Error ? e.message : String(e))));
        },
      );
    });
  }

  /**
   * 停止这一轮：turn/interrupt（实测 18ms 内以 interrupted 结束，进程保留）。turn/start 的应答还没回来时
   * 等它回来再发；失败时 reject，调用方自己决定是否拆进程兜底。
   */
  async interrupt(): Promise<void> {
    this.cancelPermissions();
    const turn = this.turn;
    if (!turn) return;
    await turn.started;
    if (turn.settled || this.turn !== turn || !turn.serverId || !this.threadId) return;
    await this.conn.request('turn/interrupt', { threadId: this.threadId, turnId: turn.serverId });
  }

  async close(): Promise<void> {
    this.cancelPermissions();
    endChild(this.o.child, this.o.kill);
  }
}
