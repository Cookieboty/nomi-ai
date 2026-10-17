/**
 * Claude Code / Codex / dsh / Grok **各自独立** 的供应商档案。
 * - 存储：userData/cli-providers/{claude,codex,dsh,grok}/store.json
 * - 写入：Claude → ~/.claude/settings.json；Codex → ~/.codex/config.toml + auth.json；
 *   dsh → $DSH_HOME/cordis.patch.yml；Grok → ~/.grok/config.toml（密钥只经环境变量注入）
 * - 与 Nomi 自有 ProviderStore（ai-providers.json）完全隔离
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserWindow, safeStorage } from 'electron';

import { t } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';
import { writePrivateFile } from '../utils/privateFile';

import {
  backupFile,
  claudeSettingsPath,
  codexAuthPath,
  codexConfigPath,
  DSH_KEY_ENV,
  GROK_KEY_ENV,
  dshPatchPath,
  grokConfigPath,
  ensureDir,
  patchClaudeSettings,
  patchCodexAuth,
  patchCodexToml,
  patchDshYaml,
  patchGrokToml,
  unpatchCodexAuth,
  unpatchCodexToml,
} from './configPatch';
import {
  type CliApiFormat,
  defaultFormat,
  dshApiName,
  formatNeedsRouting,
  grokApiBackend,
  isClaudeApiFormat,
  isCodexApiFormat,
  isDshApiFormat,
  isGrokApiFormat,
} from './formats';
import { getCliRouteService, type RouteUpstream } from './routing/CliRouteService';
import type { CliProviderInput, CliProviderKind, CliProviderProfile } from './types';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

interface StoredProfile {
  id: string;
  kind: CliProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  apiFormat: CliApiFormat;
  keyEnc: string;
  active: boolean;
  /** 来自哪个预设模板（用于品牌图标）；自定义为 'custom' */
  presetId?: string;
}

interface StoreFile {
  profiles: StoredProfile[];
}

function encrypt(plain: string): string {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain).toString('base64');
    }
  } catch {
    /* */
  }
  return Buffer.from(plain, 'utf8').toString('base64');
}

function decrypt(enc: string): string {
  if (!enc) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    }
  } catch {
    /* */
  }
  try {
    return Buffer.from(enc, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function mask(key: string): string {
  if (!key) return '';
  if (key.length <= 4) return '••••';
  return `${key.slice(0, 2)}••••${key.slice(-2)}`;
}

export interface CliProfileTestResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
  note?: string;
}

/** 各上游格式的「列出模型」探测请求（只读 GET） */
export function buildProbeRequest(
  format: CliApiFormat,
  baseUrl: string,
  key: string,
): { url: string; headers: Record<string, string> } {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (format === 'anthropic_messages') {
    return {
      url: /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`,
      headers: { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) },
    };
  }
  if (format === 'gemini_generate_content') {
    return {
      url: /\/v1(beta)?$/.test(base) ? `${base}/models` : `${base}/v1beta/models`,
      headers: key ? { 'x-goog-api-key': key } : {},
    };
  }
  return { url: `${base}/models`, headers: key ? { authorization: `Bearer ${key}` } : {} };
}

const KINDS: readonly CliProviderKind[] = ['claude', 'codex', 'dsh', 'grok'];

function normalizeFormat(kind: CliProviderKind, raw: unknown): CliApiFormat {
  if (kind === 'claude' && isClaudeApiFormat(raw)) return raw;
  if (kind === 'codex' && isCodexApiFormat(raw)) return raw;
  if (kind === 'dsh' && isDshApiFormat(raw)) return raw;
  if (kind === 'grok' && isGrokApiFormat(raw)) return raw;
  return defaultFormat(kind);
}

export class CliProviderBridge {
  private readonly home: string;
  private readonly backupRoot: string;
  private readonly storePaths: Record<CliProviderKind, string>;
  private data: Record<CliProviderKind, StoreFile> = {
    claude: { profiles: [] },
    codex: { profiles: [] },
    dsh: { profiles: [] },
    grok: { profiles: [] },
  };

  constructor(private readonly d: { root: string; logger: Logger; home?: string }) {
    this.home = d.home ?? os.homedir();
    this.backupRoot = path.join(d.root, 'backups');
    this.storePaths = {
      claude: path.join(d.root, 'claude', 'store.json'),
      codex: path.join(d.root, 'codex', 'store.json'),
      dsh: path.join(d.root, 'dsh', 'store.json'),
      grok: path.join(d.root, 'grok', 'store.json'),
    };
    // migrate legacy single store.json if present
    this.migrateLegacy(path.join(d.root, 'store.json'));
    for (const k of KINDS) this.loadKind(k);
  }

  private migrateLegacy(legacyPath: string) {
    if (!fs.existsSync(legacyPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as {
        profiles?: Array<StoredProfile & { apiFormat?: string }>;
      };
      for (const p of raw.profiles ?? []) {
        if (p.kind !== 'claude' && p.kind !== 'codex') continue;
        const fmt = normalizeFormat(p.kind, p.apiFormat);
        this.data[p.kind].profiles.push({ ...p, apiFormat: fmt });
      }
      this.saveKind('claude');
      this.saveKind('codex');
      fs.renameSync(legacyPath, `${legacyPath}.migrated`);
    } catch (e) {
      this.d.logger.warn('legacy cli provider migrate failed', e);
    }
  }

  private loadKind(kind: CliProviderKind) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePaths[kind], 'utf8')) as StoreFile;
      this.data[kind] = {
        profiles: (parsed.profiles ?? []).map((p) => ({
          ...p,
          kind,
          apiFormat: normalizeFormat(kind, p.apiFormat),
        })),
      };
    } catch {
      this.data[kind] = { profiles: [] };
    }
  }

  private saveKind(kind: CliProviderKind) {
    const file = this.storePaths[kind];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.data[kind], null, 2), 'utf8');
  }

  private allProfiles(): StoredProfile[] {
    return KINDS.flatMap((k) => this.data[k].profiles);
  }

  private toView(p: StoredProfile): CliProviderProfile {
    const key = decrypt(p.keyEnc);
    return {
      id: p.id,
      kind: p.kind,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      apiFormat: p.apiFormat,
      needsRouting: formatNeedsRouting(p.kind, p.apiFormat),
      hasKey: Boolean(key),
      keyHint: mask(key),
      active: p.active,
      presetId: p.presetId,
    };
  }

  /** 供本地路由读取当前启用上游（含明文 key，仅主进程） */
  resolveUpstream(kind: 'claude' | 'codex'): RouteUpstream | null {
    const p = this.data[kind].profiles.find((x) => x.active);
    if (!p) return null;
    return {
      kind,
      baseUrl: p.baseUrl,
      apiKey: decrypt(p.keyEnc),
      model: p.model,
      apiFormat: p.apiFormat,
    };
  }

  /**
   * 启动 dsh 时注入的环境变量：仅当 dsh 档案启用时提供 NOMI_DSH_API_KEY。
   * 无密钥的本机上游（如 Ollama）也给占位值，避免 dsh 因变量缺失拒绝启动。
   */
  dshEnv(): Record<string, string> {
    const p = this.data.dsh.profiles.find((x) => x.active);
    if (!p) return {};
    return { [DSH_KEY_ENV]: decrypt(p.keyEnc) || 'nomi-local' };
  }

  /**
   * 启动 Grok 时注入的环境变量：仅当 Grok 档案启用时提供 NOMI_GROK_API_KEY。
   * 无密钥的本机上游也给占位值，避免 Grok 因变量缺失拒绝启动。
   */
  grokEnv(): Record<string, string> {
    const p = this.data.grok.profiles.find((x) => x.active);
    if (!p) return {};
    return { [GROK_KEY_ENV]: decrypt(p.keyEnc) || 'nomi-local' };
  }

  /** 停用 dsh 档案：移除 Nomi 区块，回到 dsh 自身的默认供应商 */
  deactivateDsh(): { ok: boolean; backups: string[]; error?: string } {
    const file = dshPatchPath(this.home);
    const backups: string[] = [];
    try {
      if (fs.existsSync(file)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const b = backupFile(file, path.join(this.backupRoot, ts), 'dsh-cordis.patch.yml');
        if (b) backups.push(b);
        fs.writeFileSync(file, patchDshYaml(fs.readFileSync(file, 'utf8'), null), 'utf8');
      }
      for (const x of this.data.dsh.profiles) x.active = false;
      this.saveKind('dsh');
      this.broadcast();
      return { ok: true, backups };
    } catch (e) {
      return { ok: false, backups, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 停用某个后端的档案：只移除 Nomi 写入的连接字段，回到 CLI 自带登录 / 默认配置。
   * 先备份；其余内容原样保留。
   */
  /** 停用 Grok 档案：移除 Nomi 标记区块，回到 Grok 自身登录 / 默认配置 */
  deactivateGrok(): { ok: boolean; backups: string[]; error?: string } {
    const file = grokConfigPath(this.home);
    const backups: string[] = [];
    try {
      if (fs.existsSync(file)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const b = backupFile(file, path.join(this.backupRoot, ts), 'grok-config.toml');
        if (b) backups.push(b);
        fs.writeFileSync(file, patchGrokToml(fs.readFileSync(file, 'utf8'), null), 'utf8');
      }
      for (const x of this.data.grok.profiles) x.active = false;
      this.saveKind('grok');
      this.broadcast();
      return { ok: true, backups };
    } catch (e) {
      return { ok: false, backups, error: e instanceof Error ? e.message : String(e) };
    }
  }

  deactivate(kind: CliProviderKind): { ok: boolean; backups: string[]; error?: string } {
    if (kind === 'dsh') return this.deactivateDsh();
    if (kind === 'grok') return this.deactivateGrok();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backups: string[] = [];
    const active = this.data[kind].profiles.find((x) => x.active);
    try {
      if (kind === 'claude') {
        const file = claudeSettingsPath(this.home);
        if (fs.existsSync(file)) {
          const b = backupFile(file, path.join(this.backupRoot, ts), 'claude-settings.json');
          if (b) backups.push(b);
          fs.writeFileSync(
            file,
            patchClaudeSettings(fs.readFileSync(file, 'utf8'), {
              ANTHROPIC_API_KEY: undefined,
              ANTHROPIC_BASE_URL: undefined,
              ANTHROPIC_MODEL: undefined,
            }),
            'utf8',
          );
        }
      } else {
        const conf = codexConfigPath(this.home);
        const auth = codexAuthPath(this.home);
        if (fs.existsSync(conf)) {
          const b = backupFile(conf, path.join(this.backupRoot, ts), 'codex-config.toml');
          if (b) backups.push(b);
          fs.writeFileSync(conf, unpatchCodexToml(fs.readFileSync(conf, 'utf8')), 'utf8');
        }
        if (fs.existsSync(auth)) {
          const b = backupFile(auth, path.join(this.backupRoot, ts), 'codex-auth.json');
          if (b) backups.push(b);
          const next = unpatchCodexAuth(
            fs.readFileSync(auth, 'utf8'),
            active ? decrypt(active.keyEnc) || undefined : undefined,
          );
          if (next !== null) fs.writeFileSync(auth, next, 'utf8');
        }
      }
      for (const x of this.data[kind].profiles) x.active = false;
      this.saveKind(kind);
      this.broadcast();
      return { ok: true, backups };
    } catch (e) {
      return { ok: false, backups, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 测速：对档案的上游发一次轻量的模型列表请求，只测连通性 / 鉴权 / 延迟，不发对话。
   * Key 只在主进程里使用；错误信息里的 Key 会被抹掉。
   */
  async testProfile(id: string): Promise<CliProfileTestResult> {
    const p = this.allProfiles().find((x) => x.id === id);
    if (!p) throw new Error(t('档案不存在'));
    const key = decrypt(p.keyEnc);
    const req = buildProbeRequest(p.apiFormat, p.baseUrl, key);
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(req.url, { method: 'GET', headers: req.headers, signal: ctl.signal });
      const latencyMs = Date.now() - started;
      await res.arrayBuffer().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return { ok: true, latencyMs, status: res.status };
      if (res.status === 404 || res.status === 405) {
        // 已连通，只是该上游没有模型列表接口
        return {
          ok: true,
          latencyMs,
          status: res.status,
          note: t('已连通（该上游没有模型列表接口，无法校验 Key）'),
        };
      }
      return {
        ok: false,
        latencyMs,
        status: res.status,
        error:
          res.status === 401 || res.status === 403
            ? t('Key 无效或无权限（HTTP {0}）', res.status)
            : t('上游返回 HTTP {0}', res.status),
      };
    } catch (e) {
      const msg = ctl.signal.aborted ? t('连接超时（8 秒）') : String((e as Error).message ?? e);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: key ? msg.split(key).join('••••') : msg,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  state() {
    const route = getCliRouteService()?.getSettings();
    return {
      profiles: this.allProfiles().map((p) => this.toView(p)),
      claudeStore: this.storePaths.claude,
      codexStore: this.storePaths.codex,
      claudeSettings: claudeSettingsPath(this.home),
      codexConfig: codexConfigPath(this.home),
      dshStore: this.storePaths.dsh,
      dshConfig: dshPatchPath(this.home),
      grokStore: this.storePaths.grok,
      grokConfig: grokConfigPath(this.home),
      routing: route ?? null,
    };
  }

  upsert(input: CliProviderInput): CliProviderProfile {
    const kind = input.kind;
    const id = input.id?.trim() || randomUUID();
    const existing = this.data[kind].profiles.find((p) => p.id === id);
    const keyEnc =
      input.apiKey !== undefined && input.apiKey !== ''
        ? encrypt(input.apiKey)
        : (existing?.keyEnc ?? '');
    const apiFormat = normalizeFormat(kind, input.apiFormat ?? existing?.apiFormat);
    const next: StoredProfile = {
      id,
      kind,
      name: input.name.trim() || t('未命名'),
      baseUrl: input.baseUrl.trim(),
      model: input.model.trim(),
      apiFormat,
      keyEnc,
      active: existing?.active ?? false,
      presetId: input.presetId?.trim() || existing?.presetId,
    };
    if (existing) Object.assign(existing, next);
    else this.data[kind].profiles.push(next);
    this.saveKind(kind);
    this.broadcast();
    return this.toView(next);
  }

  remove(id: string): void {
    for (const kind of KINDS) {
      const before = this.data[kind].profiles.length;
      this.data[kind].profiles = this.data[kind].profiles.filter((p) => p.id !== id);
      if (this.data[kind].profiles.length !== before) this.saveKind(kind);
    }
    this.broadcast();
  }

  activate(id: string): {
    ok: boolean;
    backups: string[];
    restartRequired: boolean;
    usedRouting: boolean;
    error?: string;
  } {
    const p = this.allProfiles().find((x) => x.id === id);
    if (!p) {
      return {
        ok: false,
        backups: [],
        restartRequired: false,
        usedRouting: false,
        error: t('档案不存在'),
      };
    }
    const key = decrypt(p.keyEnc);
    const needs = formatNeedsRouting(p.kind, p.apiFormat);
    const route = getCliRouteService();
    const routeSettings = route?.getSettings();
    const routingOn = Boolean(
      p.kind !== 'dsh' &&
      p.kind !== 'grok' &&
      routeSettings?.enabled &&
      routeSettings?.[p.kind as 'claude' | 'codex'],
    );
    if (needs && !routingOn) {
      return {
        ok: false,
        backups: [],
        restartRequired: false,
        usedRouting: false,
        error: t('该上游格式需要先开启本地路由（高级设置）'),
      };
    }
    const useRoute = needs;
    // 本地路由令牌：CLI 请求本地路由时必须携带（路由不再接受任意来源的匿名请求）
    const routeKey = route?.authToken() ?? 'nomi-route';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backups: string[] = [];
    try {
      if (p.kind === 'dsh') {
        const file = dshPatchPath(this.home);
        const b = backupFile(file, path.join(this.backupRoot, ts), 'dsh-cordis.patch.yml');
        if (b) backups.push(b);
        ensureDir(file);
        const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        const fmt = isDshApiFormat(p.apiFormat) ? p.apiFormat : 'openai_responses';
        fs.writeFileSync(
          file,
          patchDshYaml(raw, { api: dshApiName(fmt), baseURL: p.baseUrl, model: p.model }),
          'utf8',
        );
      } else if (p.kind === 'grok') {
        const file = grokConfigPath(this.home);
        const b = backupFile(file, path.join(this.backupRoot, ts), 'grok-config.toml');
        if (b) backups.push(b);
        ensureDir(file);
        const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        const fmt = isGrokApiFormat(p.apiFormat) ? p.apiFormat : 'openai_responses';
        fs.writeFileSync(
          file,
          patchGrokToml(raw, {
            apiBackend: grokApiBackend(fmt),
            baseUrl: p.baseUrl,
            model: p.model,
          }),
          'utf8',
        );
      } else if (p.kind === 'claude') {
        const settings = claudeSettingsPath(this.home);
        const b = backupFile(settings, path.join(this.backupRoot, ts), 'claude-settings.json');
        if (b) backups.push(b);
        ensureDir(settings);
        const raw = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null;
        const baseUrl = useRoute ? (route?.cliBaseUrl('claude') ?? p.baseUrl) : p.baseUrl;
        const next = patchClaudeSettings(raw, {
          ANTHROPIC_API_KEY: useRoute ? routeKey : key || undefined,
          ANTHROPIC_BASE_URL: baseUrl || undefined,
          ANTHROPIC_MODEL: p.model || undefined,
        });
        // settings.json 里有 API Key / 路由令牌：仅当前用户可读写
        writePrivateFile(settings, next);
      } else {
        const conf = codexConfigPath(this.home);
        const auth = codexAuthPath(this.home);
        const b1 = backupFile(conf, path.join(this.backupRoot, ts), 'codex-config.toml');
        const b2 = backupFile(auth, path.join(this.backupRoot, ts), 'codex-auth.json');
        if (b1) backups.push(b1);
        if (b2) backups.push(b2);
        ensureDir(conf);
        ensureDir(auth);
        const rawConf = fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : null;
        const rawAuth = fs.existsSync(auth) ? fs.readFileSync(auth, 'utf8') : null;
        const baseUrl = useRoute ? (route?.cliBaseUrl('codex') ?? p.baseUrl) : p.baseUrl;
        fs.writeFileSync(
          conf,
          patchCodexToml(rawConf, {
            model: p.model || undefined,
            model_provider: 'nomi',
            providerName: 'nomi',
            base_url: baseUrl || undefined,
            wire_api: 'responses',
          }),
          'utf8',
        );
        writePrivateFile(auth, patchCodexAuth(rawAuth, useRoute ? routeKey : key || undefined));
      }
      for (const x of this.data[p.kind].profiles) x.active = x.id === id;
      this.saveKind(p.kind);
      this.broadcast();
      return {
        ok: true,
        backups,
        restartRequired: p.kind === 'codex' && !useRoute,
        usedRouting: Boolean(useRoute),
      };
    } catch (e) {
      return {
        ok: false,
        backups,
        restartRequired: false,
        usedRouting: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  restoreBackup(tsDir: string): { ok: boolean; error?: string } {
    const root = path.join(this.backupRoot, tsDir);
    if (!fs.existsSync(root)) return { ok: false, error: t('备份不存在') };
    try {
      const cl = path.join(root, 'claude-settings.json');
      const ct = path.join(root, 'codex-config.toml');
      const ca = path.join(root, 'codex-auth.json');
      const dp = path.join(root, 'dsh-cordis.patch.yml');
      const gk = path.join(root, 'grok-config.toml');
      if (fs.existsSync(dp)) {
        ensureDir(dshPatchPath(this.home));
        fs.copyFileSync(dp, dshPatchPath(this.home));
      }
      if (fs.existsSync(gk)) {
        ensureDir(grokConfigPath(this.home));
        fs.copyFileSync(gk, grokConfigPath(this.home));
      }
      if (fs.existsSync(cl)) {
        ensureDir(claudeSettingsPath(this.home));
        fs.copyFileSync(cl, claudeSettingsPath(this.home));
      }
      if (fs.existsSync(ct)) {
        ensureDir(codexConfigPath(this.home));
        fs.copyFileSync(ct, codexConfigPath(this.home));
      }
      if (fs.existsSync(ca)) {
        ensureDir(codexAuthPath(this.home));
        fs.copyFileSync(ca, codexAuthPath(this.home));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  listBackups(): string[] {
    try {
      return fs
        .readdirSync(this.backupRoot)
        .filter((n) => fs.statSync(path.join(this.backupRoot, n)).isDirectory())
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  private broadcast() {
    const s = this.state();
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.webContents.send('ai:cli-provider:changed', s);
      } catch {
        /* */
      }
    }
  }

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) =>
      guardedHandle(ch, fn, { owner: 'CliProviderBridge' });
    handle('ai:cli-provider:state', () => this.state());
    handle('ai:cli-provider:upsert', (p) => this.upsert(p as CliProviderInput));
    handle('ai:cli-provider:remove', (id) => {
      this.remove(String(id));
      return this.state();
    });
    handle('ai:cli-provider:activate', (id) => this.activate(String(id)));
    handle('ai:cli-provider:test', (id) => this.testProfile(String(id)));
    handle('ai:cli-provider:deactivate-dsh', () => this.deactivateDsh());
    handle('ai:cli-provider:deactivate', (k) => {
      if (!KINDS.includes(k as CliProviderKind)) throw new Error(t('档案不存在'));
      return this.deactivate(k as CliProviderKind);
    });
    handle('ai:cli-provider:backups', () => this.listBackups());
    handle('ai:cli-provider:restore', (ts) => this.restoreBackup(String(ts)));
  }
}

let inst: CliProviderBridge | null = null;
export function initCliProviderBridge(d: {
  root: string;
  logger: Logger;
  home?: string;
}): CliProviderBridge {
  inst = new CliProviderBridge(d);
  return inst;
}
export function getCliProviderBridge(): CliProviderBridge | null {
  return inst;
}
