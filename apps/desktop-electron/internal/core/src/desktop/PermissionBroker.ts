import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { t } from '../i18n';

import {
  decide,
  sanitizePolicy,
  TOOL_DEFAULT_POLICY,
  type Danger,
  type NomiPermissionMode,
  type Policy,
} from './consent';
import { guardPath, type GuardEnv, type GuardResult, type Scope } from './pathGuard';
import { checkWorkspaceRoot, resolveInWorkspace, workspaceScope } from './workspace';

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
  /** scope：请用户授权文件夹（对话窗口里的卡片：授权建议的文件夹 / 另选 / 拒绝） */
  kind?: 'scope';
  /** kind=scope：模型建议的文件夹（没有时卡片只给「选择文件夹…」） */
  scopePath?: string;
  scopeMode?: Scope['mode'];
}

/** 请求文件夹的答复：pick = 用户要自己另选一个文件夹 */
export type ScopeDecision = 'allowed' | 'pick' | 'denied' | 'timeout';

export interface ConfirmUi {
  request(req: ConfirmRequest): void;
  cancel(id: string): void;
}

/** blocked：当前权限模式不允许（「计划」档下的写 / 破坏性），没有弹确认 */
export type Decision = 'auto' | 'allowed' | 'denied' | 'timeout' | 'blocked';

export const CONFIRM_TIMEOUT_MS = 120_000;
/** 确认里预览的上限：workspace_run 的命令最长 8000 字符，要连同工作目录完整展示 */
export const CONFIRM_PREVIEW_CAP = 16_000;
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
      resolve: (d: { decision: Decision | 'pick'; remember: boolean }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<() => void>();
  ui: ConfirmUi | null = null;
  /** Nomi 对话当前的权限模式（由编程助手服务里主标签的档位注入；未注入时按默认） */
  permissionMode: () => NomiPermissionMode = () => 'acceptEdits';
  /**
   * 视图给的 Nomi 对话工作区是不是用户选过的目录（编程助手服务的 knownDir，组合根注入）。
   * 未注入时一律不认：工具按没有工作区处理（需要授权文件夹，原有行为）。
   */
  isKnownWorkspace: (dir: string) => boolean = () => false;
  /**
   * 「全部自动」：工作区里的文件工具不确认（编程助手服务的设置，组合根注入；默认关）。
   * workspace_run 不在此列：它带 force 调用，始终确认（见 workspaceTools.ts）。
   */
  autoApprove: () => boolean = () => false;
  /** 拒绝视图给的工作区时记一条日志（组合根注入） */
  onWorkspaceRejected: (dir: string, reason: string) => void = () => undefined;

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

  // ---------- Nomi 对话的工作区 ----------
  /**
   * 校验这一轮带来的工作区（ToolExecContext.cwd）：必须是用户选过的目录，且不是过宽的根 / 黑名单目录。
   * 返回工作区的真实路径；不认时返回 null 并记日志——调用方按没有工作区处理（原有行为）。
   */
  async workspaceOf(cwd: unknown): Promise<string | null> {
    if (typeof cwd !== 'string' || !cwd.trim()) return null;
    const dir = cwd.trim();
    let known: boolean;
    try {
      known = this.isKnownWorkspace(dir);
    } catch {
      known = false;
    }
    if (!known) {
      this.onWorkspaceRejected(dir, 'not a workspace the user chose');
      return null;
    }
    const r = await checkWorkspaceRoot(dir, this.envBase);
    if (!r.ok) {
      this.onWorkspaceRejected(dir, r.reason);
      return null;
    }
    return r.real;
  }

  /**
   * 工作区里的路径守卫：相对路径按工作区解析；目标（realpath 后）必须在工作区里，
   * 黑名单照旧生效。只看工作区（授权文件夹见 guardWorkspaceOrGranted）。
   */
  async guardIn(
    root: string,
    p: unknown,
    need: 'read' | 'write',
    allowMissing = false,
  ): Promise<GuardResult> {
    const g = await guardPath(
      resolveInWorkspace(p, root, this.envBase.platform),
      { ...this.envBase, scopes: [workspaceScope(root)] },
      { need, allowMissing },
    );
    if (!g.ok && g.code === 'outside_scope')
      return {
        ok: false,
        code: 'outside_scope',
        message: t('electron.common.path-is-outside-the-conversation-workspace', root),
      };
    return g;
  }

  /**
   * 对话有工作区时的路径守卫：工作区里的按 guardIn；工作区外的只有落在用户单独授权过的文件夹 / 文件
   * （持久作用域与本次运行的会话作用域，如拖到桌面角色身上的文件）里才放行，并且走原来的授权与确认流程
   * （inWorkspace = false，调用方不能按「全部自动」放行）。其它工作区外的路径照旧拒绝；黑名单在两边都生效。
   */
  async guardWorkspaceOrGranted(
    root: string,
    p: unknown,
    need: 'read' | 'write',
    allowMissing = false,
  ): Promise<{ g: GuardResult; inWorkspace: boolean }> {
    const g = await this.guardIn(root, p, need, allowMissing);
    if (g.ok) return { g, inWorkspace: true };
    if (g.code !== 'outside_scope' && g.code !== 'symlink_escape') return { g, inWorkspace: false };
    const granted = await this.guard(
      resolveInWorkspace(p, root, this.envBase.platform),
      need,
      allowMissing,
    );
    // 不在任何授权范围里：报工作区的错误（说明工作区在哪）
    if (!granted.ok && granted.code === 'outside_scope') return { g, inWorkspace: false };
    return { g: granted, inWorkspace: false };
  }

  /**
   * 工作区里的操作要不要确认：「计划」档照旧拦下写；「全部自动」开着时不确认；
   * 关着时按原来的规则确认（但不再要求授权文件夹）。带 force 的（如 workspace_run）始终确认。
   */
  async authorizeIn(i: Parameters<PermissionBroker['authorize']>[0]): Promise<Decision> {
    if (this.permissionMode() === 'plan' && i.danger !== 'read') return 'blocked';
    if (!i.force && this.autoApprove()) return 'auto';
    return this.authorize(i);
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
    /** 不受权限模式影响（云端首次发送提示：它确认的是「发给谁」，不是改动） */
    ignoreMode?: boolean;
  }): Promise<Decision> {
    const mode = i.ignoreMode ? 'acceptEdits' : this.permissionMode();
    if (mode === 'plan' && i.danger !== 'read') return 'blocked';
    const d = i.force
      ? { confirm: true, dialog: i.force.dialog, rememberable: false, reason: 'policy' as const }
      : decide({
          danger: i.danger,
          policy: this.policy(i.tool, i.danger),
          explicitPolicy: (this.settings.policies[i.tool] ?? TOOL_DEFAULT_POLICY[i.tool]) != null,
          sessionAllowed: this.sessionAllowed.has(i.tool),
          tainted: this.isTainted(i.signal),
          mode,
        });
    if (d.blocked) return 'blocked';
    if (!d.confirm) return 'auto';
    if (!this.ui) return 'denied'; // 没有界面可确认 → 拒绝
    // 发起方已取消（如对话已停止）：不再弹出确认，按拒绝处理
    if (i.signal?.aborted) return 'denied';
    const result = await this.ask(
      {
        tool: i.tool,
        danger: i.danger,
        summary: i.summary,
        argsJson: JSON.stringify(i.args ?? {}, null, 2).slice(0, 4000),
        preview: i.preview?.slice(0, CONFIRM_PREVIEW_CAP),
        dialog: d.dialog,
        rememberable: d.rememberable,
        reason: d.reason,
      },
      i.signal,
    );
    if (result.decision === 'allowed' && result.remember && result.req.rememberable)
      this.sessionAllowed.add(i.tool);
    return result.decision === 'pick' ? 'denied' : result.decision;
  }

  /**
   * 请用户授权一个文件夹（对话窗口里的卡片，不受权限模式与「全部自动」影响：授权本身就是用户的选择）。
   * 建议的文件夹先按工作区根的规则校验（绝对路径、存在、是文件夹、不过宽、不在黑名单），不过的不给
   * 「授权这个」，只能另选。allowed 时 path 为校验后的真实路径；pick = 用户要自己另选；没有界面时按拒绝处理。
   */
  async requestScope(i: {
    suggestedPath?: string;
    mode: Scope['mode'];
    /** 模型给的理由（卡片里显示） */
    reason?: string;
    signal?: AbortSignal;
  }): Promise<{ decision: ScopeDecision; path?: string }> {
    if (!this.ui || i.signal?.aborted) return { decision: 'denied' };
    const real = i.suggestedPath ? await this.scopeCandidate(i.suggestedPath) : null;
    const r = await this.ask(
      {
        tool: 'desktop_request_scope',
        danger: 'read',
        summary: t('electron.common.grant-nomi-access-to-this-folder'),
        argsJson: JSON.stringify({ path: i.suggestedPath ?? null, mode: i.mode }, null, 2),
        ...(i.reason ? { preview: i.reason.slice(0, 200) } : {}),
        dialog: false,
        rememberable: false,
        reason: 'policy',
        kind: 'scope',
        ...(real ? { scopePath: real } : {}),
        scopeMode: i.mode,
      },
      i.signal,
    );
    if (r.decision === 'allowed')
      return real ? { decision: 'allowed', path: real } : { decision: 'denied' };
    return { decision: r.decision === 'pick' || r.decision === 'timeout' ? r.decision : 'denied' };
  }

  /** 模型建议授权的文件夹能不能一键授权：按工作区根的规则校验，且必须是文件夹 */
  private async scopeCandidate(p: string): Promise<string | null> {
    const r = await checkWorkspaceRoot(p, this.envBase);
    if (!r.ok) return null;
    try {
      return (await fs.promises.stat(r.real)).isDirectory() ? r.real : null;
    } catch {
      return null;
    }
  }

  /** 发出确认请求并等答复：超时 / 发起方取消都会收起界面上的请求 */
  private ask(
    fields: Omit<ConfirmRequest, 'id' | 'expiresAt'>,
    signal?: AbortSignal,
  ): Promise<{ decision: Decision | 'pick'; remember: boolean; req: ConfirmRequest }> {
    const timeoutMs = this.opts.timeoutMs ?? CONFIRM_TIMEOUT_MS;
    const req: ConfirmRequest = {
      id: randomUUID(),
      ...fields,
      expiresAt: this.now() + timeoutMs,
    };
    return new Promise<{ decision: Decision | 'pick'; remember: boolean }>((resolve) => {
      // 发起方在登记之前就取消了（例如停止发生在 requestScope 的异步目录校验期间）：不弹卡片，直接拒绝。
      // 下面的 abort 监听只管登记之后的取消（#203）
      if (signal?.aborted) {
        resolve({ decision: 'denied', remember: false });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        this.ui?.cancel(req.id);
        resolve({ decision: 'timeout', remember: false });
      }, timeoutMs);
      this.pending.set(req.id, { req, resolve, timer });
      signal?.addEventListener(
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
    }).then((r) => ({ ...r, req }));
  }

  /**
   * 用户答复（只接受桌面角色窗口与对话窗口，见 DesktopService）。
   * pick 只对请求文件夹有效：用户要自己另选一个文件夹。
   */
  answer(id: string, allow: boolean, remember = false, pick = false): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    const decision = pick && p.req.kind === 'scope' ? 'pick' : allow ? 'allowed' : 'denied';
    p.resolve({ decision, remember: remember && p.req.rememberable });
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
    what = t('electron.common.file-contents'),
  ): Promise<null | 'local_only' | 'user_denied'> {
    if (!provider || provider.local) return null;
    if (this.settings.localOnly) return 'local_only';
    if (this.settings.cloudAcked.includes(provider.id)) return null;
    const d = await this.authorize({
      tool: 'cloud_send_notice',
      danger: 'write',
      summary: t('electron.common.will-be-sent-to-for-processing-ok', what, provider.name),
      args: { provider: provider.name },
      preview: t('electron.common.this-is-the-first-time-local-will-be', what, provider.name, what),
      signal,
      ignoreMode: true,
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
