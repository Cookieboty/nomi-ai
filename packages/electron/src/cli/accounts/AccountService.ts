/**
 * 编程助手官方账号：保险箱 + 全局切换（docs/design/cli-official-accounts.md §5–§6）。
 *
 * - 保险箱：userData/cli-accounts/<kind>.json（0600），凭据经 safeStorage 加密；不可用时拒绝保存。
 * - 切换：回收全局凭据（同一账号且更新 → 更新保险箱；陌生账号 → 先存成新账号；判断不出新旧 → 取消）
 *   → 加密备份 → 写入 → 失败用备份还原 → 通知（停用第三方供应商、重拉 Claude 长驻进程）。
 * - 凭据只在主进程内存里出现；返回给界面的只有身份（邮箱 / 套餐）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow } from 'electron';

import { t } from '../../i18n';
import { guardedHandle } from '../../security/guardedIpc';
import { decryptSecret, encryptSecret } from '../../security/secretStorage';
import { writePrivateFileAtomic } from '../../utils/privateFile';

import { adapterFor, type AdapterEnv, type CredAdapter } from './adapters';
import type { AccountIdentity, AccountKind, AccountView, CredFiles, LiveCreds } from './types';
import { ACCOUNT_KINDS } from './types';

interface StoredAccount {
  id: string;
  label: string;
  identity: AccountIdentity | null;
  createdAt: number;
  lastUsedAt?: number;
  /** 最近一次写入 / 回收时的新旧值 */
  freshness: number | null;
  credEnc: string;
}

interface KindStore {
  accounts: StoredAccount[];
  activeId: string | null;
}

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

const MAX_BACKUPS = 10;
const UNAVAILABLE = () =>
  t('系统安全存储不可用，无法安全保存官方账号凭据；请在系统钥匙串可用后重试');

export class AccountError extends Error {
  constructor(
    readonly code:
      | 'not-found'
      | 'not-logged-in'
      | 'precheck'
      | 'ambiguous'
      | 'write-failed'
      | 'storage-unavailable',
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

export class AccountService {
  private readonly stores = new Map<AccountKind, KindStore>();
  /** 同一 CLI 的切换 / 导入串行执行 */
  private readonly chains = new Map<AccountKind, Promise<unknown>>();

  constructor(
    private readonly d: {
      root: string;
      logger: Logger;
      adapterEnv?: AdapterEnv;
      /** 测试注入 */
      adapter?: (kind: AccountKind) => CredAdapter;
      now?: () => number;
      /** 切换成功：停用该 CLI 的第三方供应商、重拉长驻进程等 */
      onActivated?: (kind: AccountKind) => void;
      onChanged?: () => void;
    },
  ) {
    fs.mkdirSync(d.root, { recursive: true });
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }
  private adapter(kind: AccountKind): CredAdapter {
    return this.d.adapter?.(kind) ?? adapterFor(kind, this.d.adapterEnv);
  }
  private file(kind: AccountKind) {
    return path.join(this.d.root, `${kind}.json`);
  }
  private store(kind: AccountKind): KindStore {
    let s = this.stores.get(kind);
    if (!s) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file(kind), 'utf8')) as Partial<KindStore>;
        s = {
          accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
          activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
        };
      } catch {
        s = { accounts: [], activeId: null };
      }
      this.stores.set(kind, s);
    }
    return s;
  }
  private save(kind: AccountKind) {
    writePrivateFileAtomic(this.file(kind), JSON.stringify(this.store(kind), null, 2));
    this.d.onChanged?.();
  }
  private serial<T>(kind: AccountKind, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(kind) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      kind,
      next.catch(() => undefined),
    );
    return next;
  }

  private seal(files: CredFiles): string {
    return encryptSecret(JSON.stringify(files), UNAVAILABLE());
  }
  private open(acc: StoredAccount): CredFiles {
    const raw = decryptSecret(acc.credEnc);
    if (!raw) throw new AccountError('storage-unavailable', UNAVAILABLE());
    return JSON.parse(raw) as CredFiles;
  }

  private view(kind: AccountKind, a: StoredAccount): AccountView {
    return {
      id: a.id,
      kind,
      label: a.label,
      identity: a.identity,
      active: this.store(kind).activeId === a.id,
      createdAt: a.createdAt,
      ...(a.lastUsedAt ? { lastUsedAt: a.lastUsedAt } : {}),
    };
  }

  list(kind?: AccountKind): AccountView[] {
    return (kind ? [kind] : ACCOUNT_KINDS).flatMap((k) =>
      this.store(k).accounts.map((a) => this.view(k, a)),
    );
  }

  /** 当前全局登录的身份（不含凭据） */
  async live(kind: AccountKind): Promise<AccountIdentity | null> {
    return (await this.adapter(kind).read())?.identity ?? null;
  }

  private find(id: string): { kind: AccountKind; acc: StoredAccount } {
    for (const kind of ACCOUNT_KINDS) {
      const acc = this.store(kind).accounts.find((a) => a.id === id);
      if (acc) return { kind, acc };
    }
    throw new AccountError('not-found', t('账号不存在'));
  }

  /** 按身份存入保险箱（已有同一身份就更新凭据），返回账号 */
  private upsert(kind: AccountKind, live: LiveCreds, label?: string): StoredAccount {
    const s = this.store(kind);
    const key = live.identity?.key;
    const existing = key ? s.accounts.find((a) => a.identity?.key === key) : undefined;
    const credEnc = this.seal(live.files);
    if (existing) {
      existing.credEnc = credEnc;
      existing.identity = live.identity;
      existing.freshness = live.freshness;
      return existing;
    }
    const acc: StoredAccount = {
      id: randomUUID(),
      label: (label ?? live.identity?.email ?? t('官方账号')).slice(0, 60),
      identity: live.identity,
      createdAt: this.now(),
      freshness: live.freshness,
      credEnc,
    };
    s.accounts.push(acc);
    return acc;
  }

  /** 把当前全局登录存成账号（第一次启用、或用户在终端里另登了号） */
  importCurrent(kind: AccountKind, label?: string): Promise<AccountView> {
    return this.serial(kind, async () => {
      const live = await this.adapter(kind).read();
      if (!live) throw new AccountError('not-logged-in', t('当前没有已登录的官方账号'));
      const acc = this.upsert(kind, live, label);
      this.store(kind).activeId = acc.id;
      this.save(kind);
      return this.view(kind, acc);
    });
  }

  /** 登录流程拿到的新凭据（暂存目录里读出）存进保险箱，不改全局登录 */
  addFromLogin(kind: AccountKind, live: LiveCreds, label?: string): Promise<AccountView> {
    return this.serial(kind, async () => {
      const acc = this.upsert(kind, live, label);
      this.save(kind);
      return this.view(kind, acc);
    });
  }

  /**
   * 回收全局凭据（§5 第 1 步）。返回 null 表示可以继续；陌生账号会先存成新账号。
   * 判断不出新旧时抛 ambiguous：宁可不切，也不覆盖可能更新的登录。
   */
  private async syncBack(kind: AccountKind, adapter: CredAdapter): Promise<void> {
    const live = await adapter.read();
    if (!live) return;
    const s = this.store(kind);
    const key = live.identity?.key;
    const mine = key ? s.accounts.find((a) => a.identity?.key === key) : undefined;
    if (!mine) {
      this.upsert(kind, live, t('终端登录 · {0}', live.identity?.email ?? t('未知账号')));
      return;
    }
    const stored = this.open(mine);
    if (JSON.stringify(stored) === JSON.stringify(live.files)) return;
    if (live.freshness === null || mine.freshness === null)
      throw new AccountError(
        'ambiguous',
        t('无法判断「{0}」当前登录的凭据是不是更新的，为避免覆盖有效登录，已取消切换', mine.label),
      );
    // 保险箱里的更新（例如刚在 Nomi 里重新登录过）：保留保险箱，不用旧的全局凭据覆盖
    if (live.freshness < mine.freshness) return;
    mine.credEnc = this.seal(live.files);
    mine.freshness = live.freshness;
    mine.identity = live.identity;
  }

  private backupDir(kind: AccountKind) {
    return path.join(this.d.root, 'backups', kind);
  }

  /** 写入前把当前全局凭据加密备份（只保留最近 MAX_BACKUPS 份） */
  private backup(kind: AccountKind, live: LiveCreds | null) {
    if (!live) return;
    const dir = this.backupDir(kind);
    fs.mkdirSync(dir, { recursive: true });
    writePrivateFileAtomic(path.join(dir, `${this.now()}.enc`), this.seal(live.files));
    const all = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.enc'))
      .sort();
    for (const f of all.slice(0, Math.max(0, all.length - MAX_BACKUPS)))
      fs.rmSync(path.join(dir, f), { force: true });
  }

  /**
   * 切换全局官方账号。expectedKind：调用方以为的所属后端（界面上正在看的编程助手）；
   * 与账号实际所属不一致就拒绝，不会借过时的菜单切到另一个 CLI 的全局登录（#69）。
   */
  activate(id: string, expectedKind?: AccountKind): Promise<AccountView> {
    const { kind } = this.find(id);
    if (expectedKind !== undefined && expectedKind !== kind)
      return Promise.reject(new AccountError('not-found', t('账号不存在')));
    return this.serial(kind, async () => {
      const { acc } = this.find(id);
      const adapter = this.adapter(kind);
      const reason = adapter.precheck();
      if (reason) throw new AccountError('precheck', precheckMessage(reason), reason);
      await this.syncBack(kind, adapter);
      const before = await adapter.read();
      this.backup(kind, before);
      const target = this.open(acc);
      try {
        await adapter.write(target);
      } catch (e) {
        // 写到一半失败：用写入前的凭据还原，避免 CLI 卡在半新半旧的登录上
        if (before) await adapter.write(before.files).catch(() => undefined);
        this.save(kind);
        throw new AccountError(
          'write-failed',
          t('写入登录凭据失败，已恢复原来的登录：{0}', e instanceof Error ? e.message : String(e)),
        );
      }
      const s = this.store(kind);
      s.activeId = acc.id;
      acc.lastUsedAt = this.now();
      // 以写入后的全局凭据为准（文件类的新旧值来自修改时间），下次回收才比得出新旧
      acc.freshness = (await adapter.read())?.freshness ?? adapter.inspect(target).freshness;
      this.save(kind);
      this.d.logger.info('cli account activated', { kind, account: acc.id });
      this.d.onActivated?.(kind);
      return this.view(kind, acc);
    });
  }

  rename(id: string, label: string): AccountView {
    const { kind, acc } = this.find(id);
    const next = String(label ?? '')
      .trim()
      .slice(0, 60);
    if (!next) throw new Error(t('标题不能为空'));
    acc.label = next;
    this.save(kind);
    return this.view(kind, acc);
  }

  /** 只删保险箱里的账号；全局登录不动（要退出请用 CLI 自己的 logout） */
  remove(id: string): void {
    const { kind } = this.find(id);
    const s = this.store(kind);
    s.accounts = s.accounts.filter((a) => a.id !== id);
    if (s.activeId === id) s.activeId = null;
    this.save(kind);
  }

  /** 通知各窗口刷新账号列表（不带任何数据） */
  broadcastChanged(): void {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send('ai:cli-account:changed', null);
  }

  registerIpc(): void {
    const owner = 'AccountService';
    const kindOf = (v: unknown): AccountKind => {
      if (typeof v === 'string' && (ACCOUNT_KINDS as readonly string[]).includes(v))
        return v as AccountKind;
      throw new Error(t('未知的编程助手'));
    };
    guardedHandle('ai:cli-account:list', (k) => this.list(k ? kindOf(k) : undefined), { owner });
    guardedHandle('ai:cli-account:live', (k) => this.live(kindOf(k)), { owner });
    guardedHandle(
      'ai:cli-account:import-current',
      (k, label) => this.importCurrent(kindOf(k), label ? String(label) : undefined),
      { owner },
    );
    guardedHandle(
      'ai:cli-account:activate',
      (id, k) => this.activate(String(id), k === undefined || k === null ? undefined : kindOf(k)),
      { owner },
    );
    guardedHandle('ai:cli-account:rename', (id, label) => this.rename(String(id), String(label)), {
      owner,
    });
    guardedHandle('ai:cli-account:remove', (id) => this.remove(String(id)), { owner });
  }
}

export function precheckMessage(reason: string): string {
  switch (reason) {
    case 'codex-keyring':
      return t(
        'Codex 把登录凭据存在系统钥匙串里，无法切换账号；请先在 Codex 配置里把 cli_auth_credentials_store 改成 "file"',
      );
    case 'grok-refreshing':
      return t('Grok 正在刷新登录凭据，请稍后再切换');
    case 'gemini-encrypted-storage':
      return t(
        'Gemini 开启了加密凭据存储（GEMINI_FORCE_ENCRYPTED_FILE_STORAGE），暂不支持切换账号',
      );
    default:
      return reason;
  }
}
