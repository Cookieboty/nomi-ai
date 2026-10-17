import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { t } from '../i18n';

import { decide, sanitizePolicy, TOOL_DEFAULT_POLICY, type Danger, type Policy } from './consent';
import { guardPath, type GuardEnv, type GuardResult, type Scope } from './pathGuard';

export interface DesktopSettings {
  scopes: Scope[];
  policies: Record<string, Policy>;
  /** 仅允许本地模型读取文件内容 */
  localOnly: boolean;
  /** 已确认过「文件内容将发送给云端 provider」提示的 provider id */
  cloudAcked: string[];
}

export interface ConfirmRequest {
  id: string;
  tool: string;
  danger: Danger;
  /** 气泡里的一句话 */
  summary: string;
  argsJson: string;
  /** 干跑预览（计划 / 将写入的前几行等） */
  preview?: string;
  /** 必须在详情对话框里确认 */
  dialog: boolean;
  rememberable: boolean;
  reason: string;
  expiresAt: number;
}

export interface ConfirmUi {
  request(req: ConfirmRequest): void;
  cancel(id: string): void;
}

export type Decision = 'auto' | 'allowed' | 'denied' | 'timeout';

export const CONFIRM_TIMEOUT_MS = 120_000;
const TAINT_FALLBACK_MS = 120_000;

const DEFAULT_SETTINGS: DesktopSettings = {
  scopes: [],
  policies: {},
  localOnly: false,
  cloudAcked: [],
};

/**
 * 权限中枢（主进程）：作用域、每个工具的同意策略、确认请求（气泡 + 对话框，120s 未答复自动拒绝）、
 * 本轮是否已读取文件（受污染轮次）、本地模型限制与云端首次发送提示。
 */
export class PermissionBroker {
  private settings: DesktopSettings;
  private readonly sessionScopes: Scope[] = [];
  private readonly sessionAllowed = new Set<string>();
  private readonly taintBySignal = new WeakMap<AbortSignal, true>();
  private taintFallbackUntil = 0;
  private readonly pending = new Map<
    string,
    {
      req: ConfirmRequest;
      resolve: (d: { decision: Decision; remember: boolean }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<() => void>();
  ui: ConfirmUi | null = null;

  constructor(
    private readonly file: string,
    private readonly envBase: Omit<GuardEnv, 'scopes'>,
    private readonly opts: { timeoutMs?: number; now?: () => number } = {},
  ) {
    this.settings = this.load();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private load(): DesktopSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<DesktopSettings>;
      return {
        scopes: Array.isArray(raw.scopes)
          ? raw.scopes.filter((s) => s && typeof s.path === 'string' && !s.session)
          : [],
        policies: raw.policies && typeof raw.policies === 'object' ? raw.policies : {},
        localOnly: raw.localOnly === true,
        cloudAcked: Array.isArray(raw.cloudAcked)
          ? raw.cloudAcked.filter((x) => typeof x === 'string')
          : [],
      };
    } catch {
      return { ...DEFAULT_SETTINGS, scopes: [], policies: {}, cloudAcked: [] };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    for (const l of this.listeners) l();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- 作用域 ----------
  scopes(): Scope[] {
    return [...this.settings.scopes, ...this.sessionScopes];
  }

  grant(p: string, mode: Scope['mode'], kind: Scope['kind'] = 'folder', session = false): Scope {
    const existing = this.scopes().find((s) => s.path === p && s.kind === kind);
    if (existing) {
      if (mode === 'read-write' && existing.mode !== 'read-write') {
        existing.mode = 'read-write';
        if (!existing.session) this.save();
      }
      return existing;
    }
    const s: Scope = {
      id: randomUUID(),
      path: p,
      mode,
      kind,
      grantedAt: this.now(),
      ...(session ? { session } : {}),
    };
    if (session) this.sessionScopes.push(s);
    else {
      this.settings.scopes.push(s);
      this.save();
    }
    return s;
  }

  revoke(id: string): boolean {
    const i = this.settings.scopes.findIndex((s) => s.id === id);
    if (i >= 0) {
      this.settings.scopes.splice(i, 1);
      this.save();
      return true;
    }
    const j = this.sessionScopes.findIndex((s) => s.id === id);
    if (j >= 0) {
      this.sessionScopes.splice(j, 1);
      for (const l of this.listeners) l();
      return true;
    }
    return false;
  }

  guard(p: unknown, need: 'read' | 'write', allowMissing = false): Promise<GuardResult> {
    return guardPath(p, { ...this.envBase, scopes: this.scopes() }, { need, allowMissing });
  }

  // ---------- 策略 ----------
  policy(tool: string, danger: Danger): Policy {
    return sanitizePolicy(danger, this.settings.policies[tool] ?? TOOL_DEFAULT_POLICY[tool]);
  }

  setPolicy(tool: string, danger: Danger, p: Policy): void {
    this.settings.policies[tool] = sanitizePolicy(danger, p);
    this.sessionAllowed.delete(tool);
    this.save();
  }

  get localOnly(): boolean {
    return this.settings.localOnly;
  }

  setLocalOnly(v: boolean): void {
    this.settings.localOnly = v;
    this.save();
  }

  cloudAcked(): string[] {
    return [...this.settings.cloudAcked];
  }

  resetCloudAcks(): void {
    this.settings.cloudAcked = [];
    this.save();
  }

  // ---------- 受污染轮次 ----------
  markRead(signal?: AbortSignal): void {
    if (signal) this.taintBySignal.set(signal, true);
    else this.taintFallbackUntil = this.now() + TAINT_FALLBACK_MS;
  }

  isTainted(signal?: AbortSignal): boolean {
    if (signal) return this.taintBySignal.has(signal);
    return this.now() < this.taintFallbackUntil;
  }

  // ---------- 确认 ----------
  async authorize(i: {
    tool: string;
    danger: Danger;
    summary: string;
    args: unknown;
    preview?: string;
    signal?: AbortSignal;
    /** 强制确认（如 undo、云端首次发送提示） */
    force?: { dialog: boolean };
  }): Promise<Decision> {
    const d = i.force
      ? { confirm: true, dialog: i.force.dialog, rememberable: false, reason: 'policy' as const }
      : decide({
          danger: i.danger,
          policy: this.policy(i.tool, i.danger),
          sessionAllowed: this.sessionAllowed.has(i.tool),
          tainted: this.isTainted(i.signal),
        });
    if (!d.confirm) return 'auto';
    if (!this.ui) return 'denied'; // 没有界面可确认 → 拒绝
    const timeoutMs = this.opts.timeoutMs ?? CONFIRM_TIMEOUT_MS;
    const req: ConfirmRequest = {
      id: randomUUID(),
      tool: i.tool,
      danger: i.danger,
      summary: i.summary,
      argsJson: JSON.stringify(i.args ?? {}, null, 2).slice(0, 4000),
      preview: i.preview?.slice(0, 4000),
      dialog: d.dialog,
      rememberable: d.rememberable,
      reason: d.reason,
      expiresAt: this.now() + timeoutMs,
    };
    const result = await new Promise<{ decision: Decision; remember: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        this.ui?.cancel(req.id);
        resolve({ decision: 'timeout', remember: false });
      }, timeoutMs);
      this.pending.set(req.id, { req, resolve, timer });
      i.signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(req.id)) return;
          clearTimeout(timer);
          this.pending.delete(req.id);
          this.ui?.cancel(req.id);
          resolve({ decision: 'denied', remember: false });
        },
        { once: true },
      );
      this.ui!.request(req);
    });
    if (result.decision === 'allowed' && result.remember && req.rememberable)
      this.sessionAllowed.add(i.tool);
    return result.decision;
  }

  /** 用户答复（只接受来自看板娘窗口的 IPC，见 DesktopService） */
  answer(id: string, allow: boolean, remember = false): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve({ decision: allow ? 'allowed' : 'denied', remember: remember && p.req.rememberable });
    return true;
  }

  pendingRequests(): ConfirmRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  /**
   * 文件内容即将发送给 provider：开启「仅本地模型」时拒绝云端；云端 provider 首次发送需确认提示。
   * 返回 null 表示可以发送，否则为错误码。
   */
  async checkSend(
    provider: { id: string; name: string; local: boolean } | null,
    signal?: AbortSignal,
    what = t('文件内容'),
  ): Promise<null | 'local_only' | 'user_denied'> {
    if (!provider || provider.local) return null;
    if (this.settings.localOnly) return 'local_only';
    if (this.settings.cloudAcked.includes(provider.id)) return null;
    const d = await this.authorize({
      tool: 'cloud_send_notice',
      danger: 'write',
      summary: t('{0}将发送给「{1}」进行处理，可以吗？', what, provider.name),
      args: { provider: provider.name },
      preview: t(
        '这是第一次把本地{0}发送给云端模型「{1}」。\n{2}会离开本机，由该服务商处理。\n可以在「桌面能力 → 云端与仅本地」里开启「仅本地模型可读文件」。',
        what,
        provider.name,
        what,
      ),
      signal,
      force: { dialog: true },
    });
    if (d !== 'allowed') return 'user_denied';
    this.settings.cloudAcked.push(provider.id);
    this.save();
    return null;
  }

  view(): Omit<DesktopSettings, 'scopes'> & { scopes: Scope[] } {
    return {
      scopes: this.scopes(),
      policies: { ...this.settings.policies },
      localOnly: this.settings.localOnly,
      cloudAcked: this.cloudAcked(),
    };
  }

  /** 清除全部桌面能力数据（作用域 / 策略 / 云端提示记录） */
  resetAll(): void {
    this.settings = { scopes: [], policies: {}, localOnly: false, cloudAcked: [] };
    this.sessionScopes.splice(0);
    this.sessionAllowed.clear();
    this.save();
  }
}
