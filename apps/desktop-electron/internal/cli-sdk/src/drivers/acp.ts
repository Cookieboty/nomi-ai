/**
 * ACP（Agent Client Protocol）会话驱动：Gemini `gemini --acp`、Grok `grok agent stdio` 与未来所有说 ACP 的 CLI。
 *
 * initialize → session/load（有会话 id 时，失败退回新建）或 session/new；每轮 session/prompt
 * （按「没有动静」计时，等权限确认时暂停）；session/update 映射成 HarnessEvent；
 * session/request_permission 变成会话事件，等编排层 respondPermission；停止用 session/cancel，进程保留。
 * 模型 / 档位：session/set_model、session/set_config_option（插件按 CLI 选 configId）。
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
import type {
  HarnessEvent,
  PermissionAnswer,
  PermissionOption,
  SessionEvent,
  SlashCommand,
} from '../events';
import { JsonRpcConnection, type Json, type RpcConnectionOptions } from '../rpc/jsonrpc';

import { createAcpMapper, permissionSummary, pickPermissionOption } from './acpEvents';

/** 一轮 prompt 多久没有任何动静算卡住（默认 10 分钟；等权限确认不计时） */
export const ACP_PROMPT_IDLE_MS = 10 * 60_000;

/** Grok 的会话扩展通知（官方 ACP 文档：x.ai/session_notification 带 auto-compact；x.ai/session/update） */
const XAI_SESSION_NOTIFY = /^_?x\.ai\/session(?:_notification|\/update)$/;

type AcpMapper = ReturnType<typeof createAcpMapper>;

export interface AcpDriverOptions {
  child: ChildLike;
  /** 权限请求 id 的前缀（界面 / 测试按它区分后端） */
  permissionIdPrefix?: string;
  /** session/prompt 的无动静超时；0 = 不限 */
  promptIdleMs?: number;
  rpc?: RpcConnectionOptions;
  kill?: KillFn;
  /** 每轮新建的 session/update 映射器（插件可换成自己的） */
  mapper?: () => AcpMapper;
  clientCapabilities?: Json;
  newId?: () => string;
}

interface AcpTurnState {
  id: string;
  mapper: AcpMapper;
  text: string;
  denied: boolean;
}

interface PendingPermission {
  options: PermissionOption[];
  raw: unknown;
  resolve: (a: PermissionAnswer) => void;
}

function parseOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Json[])
    .filter((o) => typeof o?.optionId === 'string')
    .map((o) => ({
      id: o.optionId as string,
      kind: typeof o.kind === 'string' ? o.kind : '',
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
    }));
}

function parseCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Json[])
    .filter((c) => typeof c?.name === 'string')
    .map((c) => {
      const input = c.input as Json | undefined;
      return {
        name: c.name as string,
        ...(typeof c.description === 'string' ? { description: c.description } : {}),
        ...(typeof input?.hint === 'string' ? { hint: input.hint } : {}),
      };
    });
}

export class AcpDriver implements SessionDriver {
  readonly conn: JsonRpcConnection;
  private readonly hub = new EventHub<SessionEvent>();
  private turn: AcpTurnState | null = null;
  private readonly perms = new Map<string, PendingPermission>();
  private sid: string | null = null;
  private exited = false;
  /** 会话当前的权限模式 id（握手报告的或 setPermissionMode 确认过的） */
  modeId: string | undefined;
  /** initialize 应答里的能力 */
  agentCapabilities: Json = {};

  constructor(private readonly o: AcpDriverOptions) {
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
    return this.sid;
  }

  get closed(): boolean {
    return this.exited || this.conn.isClosed;
  }

  /** 进行中的这一轮是否有被拒绝的工具调用（Grok 拒绝一次会以 cancelled 结束整轮） */
  get turnDenied(): boolean {
    return this.turn?.denied ?? false;
  }

  get inTurn(): boolean {
    return this.turn !== null;
  }

  private onNotification(method: string, params: Json) {
    // Grok 的自动压缩走 x.ai 扩展通知（x.ai/session_notification；线上可能带 ACP 扩展前缀 _）。
    // 扩展通知里只取 auto_compact_*，其它内容与标准 session/update 重复
    const ext = XAI_SESSION_NOTIFY.test(method);
    if (method !== 'session/update' && !ext) return;
    const u = (params.update ?? {}) as Json;
    if (ext && !String(u.sessionUpdate ?? '').startsWith('auto_compact_')) return;
    if (u.sessionUpdate === 'available_commands_update') {
      this.hub.emit({ kind: 'commands', commands: parseCommands(u.availableCommands) });
      return;
    }
    const turn = this.turn;
    // 轮次之外的更新（如加载历史时的回放）：照样映射，但不带 turnId，编排层可以忽略
    const evs = turn ? turn.mapper.update(u) : createAcpMapper().update(u);
    for (const event of evs) {
      if (turn) turn.text = appendText(turn.text, event);
      this.hub.emit({ kind: 'harness', event, ...(turn ? { turnId: turn.id } : {}) });
    }
  }

  private async onRequest(method: string, params: Json): Promise<unknown> {
    if (method !== 'session/request_permission')
      throw new Error(`unsupported client method ${method}`);
    const id = `${this.o.permissionIdPrefix ?? 'acp-perm-'}${(this.o.newId ?? randomUUID)()}`;
    const options = parseOptions(params.options);
    const call = (params.toolCall ?? {}) as Json;
    const answer = await new Promise<PermissionAnswer>((resolve) => {
      this.perms.set(id, { options, raw: params.options, resolve });
      this.hub.emit({
        kind: 'permission',
        id,
        request: {
          summary: permissionSummary(params),
          ...(typeof call.toolCallId === 'string' ? { toolUseId: call.toolCallId } : {}),
          options,
          method,
        },
        ...(this.turn ? { turnId: this.turn.id } : {}),
      });
    });
    this.perms.delete(id);
    let optionId: string | null;
    if ('optionId' in answer) optionId = answer.optionId;
    else if (answer.decision === 'cancel') optionId = null;
    else {
      const allow = answer.decision === 'allow';
      if (!allow && this.turn) this.turn.denied = true;
      optionId = pickPermissionOption(params.options, allow);
    }
    return optionId
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  respondPermission(id: string, answer: PermissionAnswer): boolean {
    const p = this.perms.get(id);
    if (!p) return false;
    p.resolve(answer);
    return true;
  }

  /** 是否还有这个权限请求在等应答 */
  hasPermission(id: string): boolean {
    return this.perms.has(id);
  }

  /** 规范要求：取消时挂起的权限请求按 cancelled 应答 */
  private cancelPermissions() {
    for (const p of [...this.perms.values()]) p.resolve({ decision: 'cancel' });
  }

  async start(o: {
    cwd: string;
    resumeId?: string | null;
    signal?: AbortSignal;
    mcpServers?: unknown[];
  }): Promise<StartResult> {
    const opts = o.signal ? { signal: o.signal } : {};
    const init = await this.conn.request<{
      protocolVersion?: unknown;
      agentCapabilities?: Json;
    } | null>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: this.o.clientCapabilities ?? {
          fs: { readTextFile: false, writeTextFile: false },
        },
      },
      opts,
    );
    this.agentCapabilities = (init?.agentCapabilities ?? {}) as Json;
    const prompt = (this.agentCapabilities.promptCapabilities ?? {}) as Json;
    type SessionResult = { sessionId?: string; modes?: { currentModeId?: unknown } } | null;
    const mcpServers = o.mcpServers ?? [];
    let sid: string | null = null;
    let modeNow: unknown;
    let resumed = false;
    if (o.resumeId) {
      const resumeId = o.resumeId;
      sid = await this.conn
        .request<SessionResult>(
          'session/load',
          { sessionId: resumeId, cwd: o.cwd, mcpServers },
          opts,
        )
        .then((r) => {
          modeNow = r?.modes?.currentModeId;
          resumed = true;
          return resumeId;
        })
        .catch(() => null);
    }
    if (!sid) {
      const r = await this.conn.request<SessionResult>(
        'session/new',
        { cwd: o.cwd, mcpServers },
        opts,
      );
      sid = r?.sessionId ?? null;
      modeNow = r?.modes?.currentModeId;
    }
    if (!sid) throw new Error('ACP agent returned no session');
    this.sid = sid;
    if (typeof modeNow === 'string') this.modeId = modeNow;
    this.hub.emit({ kind: 'health', state: 'ready' });
    return {
      sessionId: sid,
      ...(o.resumeId ? { resumed } : {}),
      ...(typeof modeNow === 'string' ? { currentModeId: modeNow } : {}),
      ...(typeof init?.protocolVersion === 'number'
        ? { version: String(init.protocolVersion) }
        : {}),
      capabilities: {
        loadSession: this.agentCapabilities.loadSession === true,
        images: prompt.image === true,
        audio: prompt.audio === true,
      },
    };
  }

  private requireSession(): string {
    if (!this.sid) throw new Error('ACP session not started');
    return this.sid;
  }

  /** session/set_mode：得到确认才算生效（失败抛错，调用方决定这一轮还发不发） */
  async setPermissionMode(modeId: string, o: { signal?: AbortSignal } = {}): Promise<'applied'> {
    await this.conn.request(
      'session/set_mode',
      { sessionId: this.requireSession(), modeId },
      o.signal ? { signal: o.signal } : {},
    );
    this.modeId = modeId;
    return 'applied';
  }

  /** session/set_model（原地生效） */
  async setSessionModel(modelId: string): Promise<void> {
    await this.conn.request('session/set_model', { sessionId: this.requireSession(), modelId });
  }

  /** session/set_config_option（如 Grok 的 reasoning_effort） */
  async setConfigOption(configId: string, value: unknown): Promise<void> {
    await this.conn.request('session/set_config_option', {
      sessionId: this.requireSession(),
      configId,
      value,
    });
  }

  /** 通用实现：模型走 set_model；档位走 reasoning_effort 配置项（不支持的 CLI 由插件覆盖） */
  async setModel(model: string | null, effort: string | null): Promise<'applied' | 'restart'> {
    if (model === null && effort === null) return 'restart';
    if (model) await this.setSessionModel(model);
    if (effort) await this.setConfigOption('reasoning_effort', effort);
    return 'applied';
  }

  async send(input: TurnInput & { onTimeout?: () => void }): Promise<TurnResult> {
    const sessionId = this.requireSession();
    return this.runTurn(
      'session/prompt',
      { sessionId, prompt: input.blocks ?? [{ type: 'text', text: input.text }] },
      input,
    );
  }

  /**
   * 手动压缩上下文（扩展方法，如 Grok 的 `_x.ai/compact_conversation`，参数 {sessionId}）。
   * 按一轮处理：期间的更新带这一轮的 id；自己补上「压缩中 / 清状态」，CLI 另发不发 auto_compact_* 都一样。
   * 方法不存在等 RPC 错误照常 reject（RpcError），由调用方决定退回什么。
   */
  async compact(method: string, input: { onTimeout?: () => void } = {}): Promise<TurnResult> {
    const sessionId = this.requireSession();
    return this.runTurn(method, { sessionId }, input, true);
  }

  private async runTurn(
    method: string,
    params: Json,
    input: { signal?: AbortSignal; onTimeout?: () => void },
    compacting = false,
  ): Promise<TurnResult> {
    const sessionId = this.requireSession();
    if (this.turn) throw new Error('previous turn still running');
    const turn: AcpTurnState = {
      id: (this.o.newId ?? randomUUID)(),
      mapper: (this.o.mapper ?? createAcpMapper)(),
      text: '',
      denied: false,
    };
    this.turn = turn;
    const emit = (event: HarnessEvent) => {
      turn.text = appendText(turn.text, event);
      this.hub.emit({ kind: 'harness', event, turnId: turn.id });
    };
    if (compacting) emit({ type: 'status', kind: 'compact' });
    try {
      const r = await this.conn.request<{ stopReason?: string; _meta?: unknown } | null>(
        method,
        params,
        {
          // 一直有输出就不算超时；等用户确认权限时也不计时（权限另有自己的超时）
          idle: true,
          timeoutMs: this.o.promptIdleMs ?? ACP_PROMPT_IDLE_MS,
          onTimeout: () => {
            void this.interrupt();
            input.onTimeout?.();
          },
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      for (const event of turn.mapper.flush()) emit(event);
      const context = turn.mapper.context();
      return {
        turnId: turn.id,
        stopReason: r?.stopReason ?? 'end_turn',
        text: turn.text,
        sessionId,
        ...(Object.keys(context).length ? { usage: context } : {}),
        ...(turn.denied ? { denied: true } : {}),
        raw: r,
      };
    } finally {
      if (compacting) emit({ type: 'status', kind: 'clear' });
      if (this.turn === turn) this.turn = null;
    }
  }

  async interrupt(): Promise<void> {
    if (this.sid) this.conn.notify('session/cancel', { sessionId: this.sid });
    this.cancelPermissions();
  }

  async close(): Promise<void> {
    this.cancelPermissions();
    endChild(this.o.child, this.o.kill);
  }
}
