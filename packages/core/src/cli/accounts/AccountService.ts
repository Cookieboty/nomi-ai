/**
 * 编程助手官方账号（docs/design/cli-plugin-architecture.md §5.10）：一个账号 = 一个 CLI 配置目录。
 *
 * - Nomi 不收集、不存储、不中转官方凭据（S7）：登录、登出、刷新都由 CLI 自己在账号目录里完成；
 *   这里只记录账号的名字、目录与身份展示信息（邮箱 / 套餐），存在 userData/cli-accounts/accounts.json。
 * - 「本机登录」= 用户自己的 CLI 目录（~/.claude 等），每个 CLI 都有这一条，Nomi 不改其中的凭据。
 * - 「默认账号」：新标签与「跟随默认」的标签用哪个账号；改默认账号只重启跟随默认的官方标签（S5）。
 *   取代原来的「全局切换」（改写用户目录里的凭据）。
 * - 多个账号可以在不同标签里同时使用；同一账号的标签共用同一个目录（S10）。
 * - 旧版本保险箱里的凭据在启动时清除，账号变成「需要重新登录」（§5.10.9）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claude, codex, gemini, grok, terminalLine } from '@nomi-ai/cli-plugins/main';
import type { TerminalCapability } from '@nomi-ai/cli-sdk';

import type { AppEvents } from '../../core/appEvents';
import { t } from '../../i18n';
import { runLimited, STDOUT_LIMIT } from '../../usage/limitedProcess';
import { writePrivateFileAtomic, writePrivateFileAtomicAsync } from '../../utils/privateFile';
import { resolveCliBinAsync, withCliPath } from '../detect';

import { claudeAccountName, claudeKeychainService } from './adapters';
import {
  accountDirFor,
  ensureAccountHome,
  logoutArgs,
  HOME_ENV,
  OFFICIAL_STRIP,
  officialAccountArgs,
  officialAccountEnv,
  userCliHome,
  type HomeProblem,
} from './homes';
import { readIdentity, type IdentityDeps, type ReadIdentity } from './identity';
import { macKeychain, type KeychainAdapter } from './keychain';
import { liveProcesses, type LiveCheck } from './liveProcesses';
import type { AccountIdentity, AccountKind, AccountView } from './types';
import { ACCOUNT_KINDS } from './types';

interface AccountRecord {
  id: string;
  kind: AccountKind;
  label: string;
  /** 账号目录；null = 用户自己的 CLI 目录（本机登录） */
  dir: string | null;
  identity: AccountIdentity | null;
  loggedIn: boolean;
  /** 从旧版本迁移来、还没重新登录 */
  needsLogin?: boolean;
  createdAt: number;
  lastUsedAt?: number;
}

interface StoreFile {
  version: 2;
  accounts: AccountRecord[];
  defaults: Partial<Record<AccountKind, string>>;
}

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

/** 「在终端里用这个账号」的命令（插件给出，§5.10） */
const TERMINAL: Record<AccountKind, TerminalCapability> = {
  claude: claude.createMain().terminal!,
  codex: codex.createMain().terminal!,
  grok: grok.createMain().terminal!,
  gemini: gemini.createMain().terminal!,
};

const FILE = 'accounts.json';
/** Nomi 启动的官方会话跑在哪个账号里（`<kind>:<sessionId>` → 账号 id）；不含凭据 */
const SESSIONS_FILE = 'session-accounts.json';
const MAX_SESSIONS = 5000;
const LOGOUT_TIMEOUT_MS = 20_000;

/** 身份键的主体（`|` 后是账号 id 等别名） */
const primaryKey = (key: string) => key.split('|')[0] ?? key;

export class AccountError extends Error {
  constructor(
    readonly code: 'not-found' | 'in-use' | 'local' | 'unsupported' | 'unknown-live',
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

/** 一个官方会话的启动注入（编排层使用） */
export interface OfficialLaunch {
  /** 账号目录；null = 用户自己的 CLI 目录 */
  dir: string | null;
  env: Record<string, string>;
  strip: string[];
  args: string[];
  /** 进程复用签名：账号目录变了就重启 */
  sig: string;
  /** 共享条目链不上的问题（界面提示） */
  problems: HomeProblem[];
}

export const localAccountId = (kind: AccountKind) => `local-${kind}`;

export class AccountService {
  private data: StoreFile | null = null;

  constructor(
    private readonly d: {
      root: string;
      logger: Logger;
      /** 账号列表变化通知界面（ai:cli-account:changed） */
      events: AppEvents;
      env?: NodeJS.ProcessEnv;
      home?: string;
      platform?: NodeJS.Platform;
      keychain?: KeychainAdapter;
      /** 测试注入 */
      identity?: IdentityDeps;
      now?: () => number;
      /** 改了默认账号：重启跟随默认账号的官方标签、作废额度缓存 */
      onDefaultChanged?: (kind: AccountKind) => void;
      /** 某个账号目录正被几个标签 / 进程使用（删除账号前检查） */
      inUse?: (kind: AccountKind, accountId: string) => number;
      onChanged?: () => void;
      /** 测试注入：CLI 的登出命令 */
      logout?: (kind: AccountKind, env: NodeJS.ProcessEnv) => Promise<void>;
      /** 测试注入：账号目录里 Nomi 之外还活着的 CLI 进程 */
      liveProcesses?: (kind: AccountKind, dir: string) => Promise<LiveCheck>;
    },
  ) {
    fs.mkdirSync(d.root, { recursive: true });
  }

  private sessions: Map<string, string> | null = null;

  private now() {
    return this.d.now?.() ?? Date.now();
  }
  private get env(): NodeJS.ProcessEnv {
    return this.d.env ?? process.env;
  }
  private get file() {
    return path.join(this.d.root, FILE);
  }

  private store(): StoreFile {
    if (this.data) return this.data;
    let s: StoreFile = { version: 2, accounts: [], defaults: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoreFile>;
      if (raw.version === 2 && Array.isArray(raw.accounts))
        s = { version: 2, accounts: raw.accounts, defaults: raw.defaults ?? {} };
    } catch {
      /* 第一次 */
    }
    // 每个 CLI 都有「本机登录」这一条
    for (const kind of ACCOUNT_KINDS) {
      if (!s.accounts.some((a) => a.id === localAccountId(kind)))
        s.accounts.unshift({
          id: localAccountId(kind),
          kind,
          label: t('electron.common.this-computer-s-sign-in'),
          dir: null,
          identity: null,
          loggedIn: false,
          createdAt: this.now(),
        });
    }
    this.data = s;
    this.migrateVault();
    return s;
  }

  private save() {
    writePrivateFileAtomic(this.file, JSON.stringify(this.store(), null, 2));
    this.d.onChanged?.();
  }

  /**
   * 旧版本的保险箱（userData/cli-accounts/<kind>.json，含加密凭据）与备份：账号转成「需要重新登录」
   * （§5.10.9）。原子性：先写出 needsLogin 记录并落盘 accounts.json，成功后再删保险箱 / 备份 / 暂存；
   * 解析失败时尽量为可恢复身份写 stub，并把保险箱挪到一边归档（不静默清空）；写盘失败则保留原文件。
   */
  private migrateVault() {
    const s = this.data!;
    const beforeLen = s.accounts.length;
    let migrated = 0;
    /** 解析成功、可安全删除的保险箱 */
    const pendingDelete: string[] = [];
    /** 解析失败：写出 stub（如有）后归档，绝不静默 rm */
    const pendingArchive: string[] = [];
    for (const kind of ACCOUNT_KINDS) {
      const legacy = path.join(this.d.root, `${kind}.json`);
      if (!fs.existsSync(legacy)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(legacy, 'utf8')) as {
          accounts?: Array<{
            label?: string;
            identity?: AccountIdentity | null;
            createdAt?: number;
          }>;
        };
        for (const a of raw.accounts ?? []) {
          const id = randomUUID();
          s.accounts.push({
            id,
            kind,
            label: String(
              a.label ?? a.identity?.email ?? t('electron.common.official-account'),
            ).slice(0, 60),
            dir: accountDirFor(this.d.root, kind, id),
            identity: a.identity ?? null,
            loggedIn: false,
            needsLogin: true,
            createdAt: a.createdAt ?? this.now(),
          });
          migrated++;
        }
        pendingDelete.push(legacy);
      } catch (e) {
        this.d.logger.warn('legacy account vault unreadable; will archive after stubs', {
          kind,
          error: String(e),
        });
        // 解析失败：尽量从残片里捞可展示的身份写 needsLogin stub
        try {
          const blob = fs.readFileSync(legacy, 'utf8');
          const emails = [...blob.matchAll(/"email(?:Address)?"\s*:\s*"([^"]+)"/g)].map(
            (m) => m[1],
          );
          const labels = [...blob.matchAll(/"label"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
          const n = Math.max(emails.length, labels.length);
          for (let i = 0; i < n; i++) {
            const id = randomUUID();
            const email = emails[i];
            const label = String(labels[i] ?? email ?? t('electron.common.official-account')).slice(
              0,
              60,
            );
            s.accounts.push({
              id,
              kind,
              label,
              dir: accountDirFor(this.d.root, kind, id),
              identity: email ? { key: email, email } : null,
              loggedIn: false,
              needsLogin: true,
              createdAt: this.now(),
            });
            migrated++;
          }
        } catch {
          /* 连残片都读不了 */
        }
        pendingArchive.push(legacy);
      }
    }
    const touched = pendingDelete.length > 0 || pendingArchive.length > 0;
    if (!touched) return;

    // 有变更才写 accounts.json；失败则回滚内存并保留保险箱 / 备份 / 暂存
    if (migrated > 0 || pendingDelete.length > 0) {
      try {
        writePrivateFileAtomic(this.file, JSON.stringify(s, null, 2));
      } catch (e) {
        s.accounts.length = beforeLen;
        this.d.logger.warn('legacy vault migration write failed; vault kept', String(e));
        return;
      }
    }

    // 只有 accounts.json 落盘成功（或无需新记录但解析成功）后才动保险箱
    for (const f of pendingDelete) fs.rmSync(f, { force: true });
    for (const f of pendingArchive) {
      const base = path.basename(f, '.json');
      const archive = path.join(this.d.root, 'vault-unreadable', `${base}-${this.now()}.json`);
      try {
        fs.mkdirSync(path.dirname(archive), { recursive: true });
        fs.renameSync(f, archive);
        this.d.logger.warn('legacy vault archived (unreadable, not deleted)', {
          archive,
        });
      } catch (err) {
        this.d.logger.warn('legacy vault left in place (archive failed)', {
          file: f,
          error: String(err),
        });
      }
    }
    // 备份 / 暂存含凭据：仅在成功写出 needsLogin（或干净解析后无账号）后清除
    if (migrated > 0 || pendingDelete.length > 0) {
      for (const dir of ['backups', 'staging'])
        fs.rmSync(path.join(this.d.root, dir), { recursive: true, force: true });
    }
    if (migrated)
      this.d.logger.info('legacy account vault migrated (credentials removed)', { migrated });
  }

  private find(id: string): AccountRecord {
    const a = this.store().accounts.find((x) => x.id === id);
    if (!a) throw new AccountError('not-found', t('electron.common.account-not-found'));
    return a;
  }

  defaultId(kind: AccountKind): string {
    const s = this.store();
    const id = s.defaults[kind];
    return id && s.accounts.some((a) => a.id === id && a.kind === kind) ? id : localAccountId(kind);
  }

  /** 默认账号的账号目录（null = 用户自己的 CLI 目录）；只读，不补齐目录 */
  defaultDir(kind: AccountKind): string | null {
    return this.store().accounts.find((a) => a.id === this.defaultId(kind))?.dir ?? null;
  }

  private view(a: AccountRecord): AccountView {
    let problems: HomeProblem[] | undefined;
    if (a.dir) {
      problems = ensureAccountHome(
        a.kind,
        a.dir,
        userCliHome(a.kind, this.env, this.d.home),
        this.d.platform,
      );
      if (problems.length)
        this.d.logger.warn('account home shared entries not linked', {
          kind: a.kind,
          id: a.id,
          problems,
        });
      else problems = undefined;
    }
    return {
      id: a.id,
      kind: a.kind,
      label: a.label,
      identity: a.identity,
      active: this.defaultId(a.kind) === a.id,
      local: a.dir === null,
      loggedIn: a.loggedIn,
      ...(a.needsLogin ? { needsLogin: true } : {}),
      inUse: this.d.inUse?.(a.kind, a.id) ?? 0,
      duplicateOf: this.duplicateOf(a),
      ...(a.dir ? { terminalCommand: this.terminalCommand(a.kind, a.dir) } : {}),
      ...(problems?.length ? { problems } : {}),
      createdAt: a.createdAt,
      ...(a.lastUsedAt ? { lastUsedAt: a.lastUsedAt } : {}),
    };
  }

  /**
   * 在终端里用这个账号运行 CLI 的命令（Anthropic 文档的多账号用法：设凭据目录变量再运行 CLI）。
   * 只包含目录路径，不含任何凭据。
   */
  private terminalCommand(kind: AccountKind, dir: string): string {
    const cmd = TERMINAL[kind].command({ cwd: '', env: {} });
    return terminalLine(
      { ...cmd, env: { [HOME_ENV[kind]]: dir } },
      this.d.platform ?? process.platform,
    );
  }

  /** S10：同一身份登录在另一个目录（两处各自刷新会让其中一处失效） */
  private duplicateOf(a: AccountRecord): string | undefined {
    const key = a.identity?.key ? primaryKey(a.identity.key) : '';
    if (!key || !a.loggedIn) return undefined;
    return this.store().accounts.find(
      (x) =>
        x.id !== a.id &&
        x.kind === a.kind &&
        x.loggedIn &&
        !!x.identity?.key &&
        primaryKey(x.identity.key) === key,
    )?.label;
  }

  list(kind?: AccountKind): AccountView[] {
    return this.store()
      .accounts.filter((a) => !kind || a.kind === kind)
      .map((a) => this.view(a));
  }

  /** 按 CLI 会话里记录的账号 id 反查（只看身份元信息） */
  findByAccountId(kind: AccountKind, accountId: string): AccountView | undefined {
    const id = accountId.trim();
    if (!id) return undefined;
    const a = this.store().accounts.find(
      (x) =>
        x.kind === kind &&
        (x.identity?.org === id || (x.identity?.key.split('|').includes(id) ?? false)),
    );
    return a ? this.view(a) : undefined;
  }

  private sessionMap(): Map<string, string> {
    if (this.sessions) return this.sessions;
    const m = new Map<string, string>();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.d.root, SESSIONS_FILE), 'utf8')) as {
        sessions?: unknown;
      };
      if (Array.isArray(raw.sessions))
        for (const e of raw.sessions)
          if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string')
            m.set(e[0], e[1]);
    } catch {
      /* 第一次 */
    }
    this.sessions = m;
    return m;
  }

  /**
   * 记下官方会话跑在哪个账号里（S9：会话目录是共享的，文件本身看不出账号）。
   * 历史列表据此标注，打开历史会话时按原账号续接；只留最近 MAX_SESSIONS 条。
   */
  noteSession(kind: AccountKind, sessionId: string, accountId: string | null | undefined): void {
    const sid = sessionId.trim();
    if (!sid) return;
    const id = this.resolve(kind, accountId);
    const m = this.sessionMap();
    const key = `${kind}:${sid}`;
    if (m.get(key) === id) return;
    m.delete(key);
    m.set(key, id);
    while (m.size > MAX_SESSIONS) m.delete(m.keys().next().value!);
    // 每次开会话都会写：异步落盘不挡主进程（#154），内存里的映射已是最新
    void writePrivateFileAtomicAsync(
      path.join(this.d.root, SESSIONS_FILE),
      JSON.stringify({ version: 1, sessions: [...m] }),
    ).catch((e) => this.d.logger.warn('session-accounts write failed', String(e)));
  }

  /** 会话所在的账号（还存在时）：id 与展示名（邮箱优先） */
  sessionAccount(kind: AccountKind, sessionId: string): { id: string; label: string } | undefined {
    const id = this.sessionMap().get(`${kind}:${sessionId}`);
    const a = id ? this.store().accounts.find((x) => x.id === id && x.kind === kind) : undefined;
    return a ? { id: a.id, label: a.identity?.email ?? a.label } : undefined;
  }

  /** 身份的稳定键（额度指纹用）；不读凭据 */
  identityKey(kind: AccountKind, accountId?: string | null): string | null {
    const a = this.store().accounts.find((x) => x.id === (accountId ?? this.defaultId(kind)));
    return a?.identity?.key ?? null;
  }

  /** 读一次账号的身份（CLI 状态命令 / 非凭据文件），更新记录 */
  async refresh(id: string): Promise<AccountView> {
    const a = this.find(id);
    const prev = a.identity;
    const r: ReadIdentity = await readIdentity(a.kind, a.dir, {
      ...this.d.identity,
      env: this.d.identity?.env ?? this.env,
      home: this.d.home,
      // Codex 账号 id 要额外请求一次 OpenAI：每个身份只读一次
      withAccountId: a.kind === 'codex' && !prev?.accountIdChecked,
    });
    a.loggedIn = r.loggedIn;
    if (r.loggedIn) {
      delete a.needsLogin;
      // 同一身份：沿用上次读到的账号 id 别名（这次没再读）
      const same = !!prev && !!r.key && primaryKey(prev.key) === primaryKey(r.key);
      const key = r.key && same && !r.accountIdChecked ? prev.key : (r.key ?? prev?.key ?? a.id);
      const checked = r.accountIdChecked || (same && prev?.accountIdChecked);
      a.identity = {
        key,
        ...(r.email ? { email: r.email } : {}),
        ...(r.plan ? { plan: r.plan } : {}),
        ...(r.org ? { org: r.org } : {}),
        ...(checked ? { accountIdChecked: true } : {}),
      };
      if (a.dir && r.email && (a.label === t('electron.common.official-account') || !a.label))
        a.label = r.email;
    }
    this.save();
    return this.view(a);
  }

  /** 刷新某个 CLI 全部账号的身份（打开官方账号区时调用） */
  async refreshAll(kind: AccountKind): Promise<AccountView[]> {
    for (const a of this.store().accounts.filter((x) => x.kind === kind))
      await this.refresh(a.id).catch((e) =>
        this.d.logger.warn('account identity refresh failed', String(e)),
      );
    return this.list(kind);
  }

  /** 新建账号（建好账号目录；登录由 AccountLogin 在目录里跑 CLI 自己的命令） */
  create(kind: AccountKind, label?: string): AccountView {
    const id = randomUUID();
    const dir = accountDirFor(this.d.root, kind, id);
    const problems = ensureAccountHome(
      kind,
      dir,
      userCliHome(kind, this.env, this.d.home),
      this.d.platform,
    );
    if (problems.length)
      this.d.logger.warn('account home shared entries not linked', { kind, problems });
    const a: AccountRecord = {
      id,
      kind,
      label:
        String(label ?? t('electron.common.official-account')).slice(0, 60) ||
        t('electron.common.official-account'),
      dir,
      identity: null,
      loggedIn: false,
      createdAt: this.now(),
    };
    this.store().accounts.push(a);
    this.save();
    return this.view(a);
  }

  /** 登录用的目录与环境：账号目录（或用户目录）+ 剔除 S3 变量 */
  loginTarget(id: string): { kind: AccountKind; dir: string | null; env: NodeJS.ProcessEnv } {
    const a = this.find(id);
    if (a.dir)
      ensureAccountHome(a.kind, a.dir, userCliHome(a.kind, this.env, this.d.home), this.d.platform);
    return {
      kind: a.kind,
      dir: a.dir,
      env: officialAccountEnv(a.kind, withCliPath(this.env), a.dir),
    };
  }

  setDefault(kind: AccountKind, id: string): AccountView {
    const a = this.find(id);
    if (a.kind !== kind)
      throw new AccountError('not-found', t('electron.common.account-not-found'));
    const before = this.defaultId(kind);
    this.store().defaults[kind] = id;
    a.lastUsedAt = this.now();
    this.save();
    if (before !== id) this.d.onDefaultChanged?.(kind);
    return this.view(a);
  }

  rename(id: string, label: string): AccountView {
    const a = this.find(id);
    const next = String(label ?? '')
      .trim()
      .slice(0, 60);
    if (!next) throw new Error(t('electron.common.title-cannot-be-empty'));
    a.label = next;
    this.save();
    return this.view(a);
  }

  /**
   * 删除账号：确认没有标签在用 → 在账号目录里执行 CLI 自己的登出（撤销令牌）→ 删除目录。
   * 「本机登录」不能删（那是用户自己的 CLI 目录）。
   */
  async remove(id: string, opts?: { force?: boolean }): Promise<void> {
    const a = this.find(id);
    if (!a.dir)
      throw new AccountError('local', t('electron.common.this-computer-s-sign-in-is-the-cli'));
    const busy = this.d.inUse?.(a.kind, a.id) ?? 0;
    if (busy > 0)
      throw new AccountError(
        'in-use',
        t('electron.common.tab-s-still-use-this-account-close-them', String(busy)),
      );
    // 终端里直接运行、用着这个账号目录的 CLI：忙则绝不删；查不出（Windows 非 Claude）须 force
    const live = await (
      this.d.liveProcesses ?? ((k, dir) => liveProcesses(k, dir, { platform: this.d.platform }))
    )(a.kind, a.dir).catch((): LiveCheck => ({ state: 'unknown' }));
    if (live.state === 'busy')
      throw new AccountError(
        'in-use',
        t(
          'electron.common.cli-process-es-outside-nomi-still-use-this',
          String(live.pids.length),
          live.pids.slice(0, 5).join(', '),
        ),
      );
    if (live.state === 'unknown' && !opts?.force)
      throw new AccountError(
        'unknown-live',
        t('electron.common.could-not-confirm-whether-a-cli-is-still'),
      );
    if (live.state === 'unknown' && opts?.force)
      this.d.logger.warn('account remove forced while liveProcesses unknown', {
        id: a.id,
        kind: a.kind,
      });
    if (a.loggedIn) {
      const env = officialAccountEnv(a.kind, withCliPath(this.env), a.dir);
      await (this.d.logout ?? cliLogout)(a.kind, env).catch((e) =>
        this.d.logger.warn('account logout failed', String(e)),
      );
    }
    await this.removeKeychainEntry(a);
    fs.rmSync(a.dir, { recursive: true, force: true });
    const s = this.store();
    s.accounts = s.accounts.filter((x) => x.id !== id);
    if (s.defaults[a.kind] === id) {
      delete s.defaults[a.kind];
      this.save();
      this.d.onDefaultChanged?.(a.kind);
      return;
    }
    this.save();
  }

  /** macOS：Claude 按目录区分的钥匙串条目在目录删除后就无法再算出名字，先删（只删除，不读取） */
  private async removeKeychainEntry(a: AccountRecord) {
    if (a.kind !== 'claude' || !a.dir || (this.d.platform ?? process.platform) !== 'darwin') return;
    const keychain = this.d.keychain ?? macKeychain;
    await keychain
      .remove(
        claudeKeychainService({ CLAUDE_CONFIG_DIR: a.dir }, a.dir),
        claudeAccountName(this.env),
      )
      .catch(() => undefined);
  }

  /** 登录前清掉同目录残留的钥匙串条目（旧条目会挡住新登录，claude-swap 的经验） */
  async prepareLogin(id: string): Promise<void> {
    await this.removeKeychainEntry(this.find(id));
  }

  /** 编排层：某个官方标签的启动注入。accountId 为空 = 跟随默认账号 */
  officialLaunch(kind: AccountKind, accountId: string | null | undefined): OfficialLaunch {
    const id =
      accountId && this.store().accounts.some((a) => a.id === accountId)
        ? accountId
        : this.defaultId(kind);
    const a = this.find(id);
    let problems: HomeProblem[] = [];
    if (a.dir)
      problems = ensureAccountHome(
        kind,
        a.dir,
        userCliHome(kind, this.env, this.d.home),
        this.d.platform,
      );
    const env: Record<string, string> = {};
    if (a.dir) {
      env[HOME_ENV[kind]] = a.dir;
      if (kind === 'claude') env.CLAUDE_CODE_DISABLE_AGENT_VIEW = '1';
    }
    // 默认（本机）账号：保留用户自己设的配置目录变量
    const strip = OFFICIAL_STRIP[kind].filter((k) => a.dir || k !== HOME_ENV[kind]);
    return {
      dir: a.dir,
      env,
      strip,
      args: officialAccountArgs(kind, a.dir),
      sig: `official:${a.id}`,
      problems,
    };
  }

  /** 这个账号 id 解析出来的实际账号（标签上记的账号可能已被删除） */
  resolve(kind: AccountKind, accountId: string | null | undefined): string {
    return accountId && this.store().accounts.some((a) => a.id === accountId && a.kind === kind)
      ? accountId
      : this.defaultId(kind);
  }

  /** 通知各窗口刷新账号列表（不带任何数据） */
  broadcastChanged(): void {
    this.d.events.publish('ai:cli-account:changed', null);
  }
}

/** 渲染层传来的编程助手 id → 有官方账号的 CLI；其他值报错（契约处理函数用） */
export function parseAccountKind(v: unknown): AccountKind {
  if (typeof v === 'string' && (ACCOUNT_KINDS as readonly string[]).includes(v))
    return v as AccountKind;
  throw new Error(t('electron.common.unknown-coding-agent'));
}

/** 在账号目录里执行 CLI 自己的登出（会撤销令牌）；Gemini 没有登出命令，直接删目录 */
async function cliLogout(kind: AccountKind, env: NodeJS.ProcessEnv): Promise<void> {
  const a = logoutArgs(kind);
  if (!a) return;
  const bin = await resolveCliBinAsync(kind);
  if (!bin) return;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-acct-logout-'));
  try {
    await runLimited(bin, a, { cwd, env, timeoutMs: LOGOUT_TIMEOUT_MS, maxBytes: STDOUT_LIMIT });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

export function precheckMessage(reason: string): string {
  switch (reason) {
    case 'gemini-encrypted-storage':
      return t('electron.common.gemini-has-encrypted-credential-storage-turned-on-gemini');
    default:
      return reason;
  }
}
