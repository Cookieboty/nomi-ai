/**
 * Claude Code / Codex / dsh / Grok / Gemini **各自独立** 的第三方供应商。
 * - 存储：userData/cli-providers/{claude,codex,dsh,grok,gemini}/store.json
 * - 写入：Claude → ~/.claude/settings.json；Codex → ~/.codex/config.toml + auth.json；
 *   dsh → $DSH_HOME/cordis.patch.yml；Grok → ~/.grok/config.toml（密钥只经环境变量注入）；
 *   Gemini → 不写 ~/.gemini：Nomi 私有的系统级设置（只含认证方式）+ 启动时注入 Key / 地址 / 模型
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
  GrokInlineModelsError,
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

/** 各格式的模型列表响应 → 模型 id：OpenAI / Anthropic `data[].id`，Gemini `models[].name`（去掉 models/） */
export function parseModelList(body: unknown): string[] {
  const o = (body ?? {}) as { data?: unknown; models?: unknown };
  const list = Array.isArray(o.data) ? o.data : Array.isArray(o.models) ? o.models : [];
  const ids = list.map((x) => {
    const m = (x ?? {}) as { id?: unknown; name?: unknown };
    const id = typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : '';
    return id.replace(/^models\//, '').trim();
  });
  return [...new Set(ids.filter(Boolean))];
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

const KINDS: readonly CliProviderKind[] = ['claude', 'codex', 'dsh', 'grok', 'gemini'];

function normalizeFormat(kind: CliProviderKind, raw: unknown): CliApiFormat {
  if (kind === 'claude' && isClaudeApiFormat(raw)) return raw;
  if (kind === 'codex' && isCodexApiFormat(raw)) return raw;
  if (kind === 'dsh' && isDshApiFormat(raw)) return raw;
  if (kind === 'grok' && isGrokApiFormat(raw)) return raw;
  return defaultFormat(kind);
}

/** 回滚成功时给错误信息补一句说明。翻译键只在 t() 里出现一次（模板字面量里嵌 t() 会被 i18n 检查当成整句键）。 */
function withRestoredNote(error: string): string {
  const note = t('已恢复为修改前的配置');
  return `${error}（${note}）`;
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
    gemini: { profiles: [] },
  };

  /**
   * 正在使用（active）的供应商被编辑后、重新写入 CLI 配置前的完整旧快照。
   * 重新启用成功就丢弃；失败则恢复，避免「存储里是新端点 / 新 Key，CLI 配置文件还是旧的」的混配。
   */
  private readonly rollbacks = new Map<string, StoredProfile>();

  /** 配置已写入 CLI 启动时才会读的文件。由 harness 悄悄换下一轮进程。 */
  private onApplied: ((kind: CliProviderKind) => void) | null = null;

  constructor(private readonly d: { root: string; logger: Logger; home?: string }) {
    this.home = d.home ?? os.homedir();
    this.backupRoot = path.join(d.root, 'backups');
    this.storePaths = {
      claude: path.join(d.root, 'claude', 'store.json'),
      codex: path.join(d.root, 'codex', 'store.json'),
      dsh: path.join(d.root, 'dsh', 'store.json'),
      grok: path.join(d.root, 'grok', 'store.json'),
      gemini: path.join(d.root, 'gemini', 'store.json'),
    };
    // migrate legacy single store.json if present
    this.migrateLegacy(path.join(d.root, 'store.json'));
    for (const k of KINDS) this.loadKind(k);
  }

  /** 启用或停用成功之后调用。失败的写入不会调用。 */
  setOnApplied(fn: (kind: CliProviderKind) => void): void {
    this.onApplied = fn;
  }

  private applied(kind: CliProviderKind) {
    try {
      this.onApplied?.(kind);
    } catch (e) {
      this.d.logger.warn('cli provider applied hook failed', e);
    }
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
   * 启动 dsh 时注入的环境变量：仅当 dsh 供应商启用时提供 NOMI_DSH_API_KEY。
   * 无密钥的本机上游（如 Ollama）也给占位值，避免 dsh 因变量缺失拒绝启动。
   */
  dshEnv(): Record<string, string> {
    const p = this.data.dsh.profiles.find((x) => x.active);
    if (!p) return {};
    return { [DSH_KEY_ENV]: decrypt(p.keyEnc) || 'nomi-local' };
  }

  /**
   * 启动 Grok 时注入的环境变量：仅当 Grok 供应商启用时提供 NOMI_GROK_API_KEY。
   * 无密钥的本机上游也给占位值，避免 Grok 因变量缺失拒绝启动。
   */
  grokEnv(): Record<string, string> {
    const p = this.data.grok.profiles.find((x) => x.active);
    if (!p) return {};
    return { [GROK_KEY_ENV]: decrypt(p.keyEnc) || 'nomi-local' };
  }

  /** Gemini 供应商启用时给 CLI 的系统级设置文件：优先级高于 ~/.gemini/settings.json，只放认证方式 */
  private geminiSystemSettingsPath(): string {
    return path.join(this.d.root, 'gemini', 'system-settings.json');
  }

  /**
   * 启动 Gemini 时注入的环境变量（仅供应商启用时）：系统级设置把认证方式定为 API Key / 网关，
   * Key、地址、模型都走环境变量，不改用户的 ~/.gemini，也就不会动到 Google 登录。
   */
  geminiEnv(): Record<string, string> {
    const p = this.data.gemini.profiles.find((x) => x.active);
    const file = this.geminiSystemSettingsPath();
    if (!p || !fs.existsSync(file)) return {};
    return {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: file,
      GEMINI_API_KEY: decrypt(p.keyEnc) || 'nomi-local',
      ...(p.baseUrl.trim() ? { GOOGLE_GEMINI_BASE_URL: p.baseUrl.trim() } : {}),
      ...(p.model.trim() ? { GEMINI_MODEL: p.model.trim() } : {}),
    };
  }

  /** 停用 Gemini 供应商：删掉 Nomi 的系统级设置，回到 Gemini 自己的登录 */
  deactivateGemini(): { ok: boolean; backups: string[]; error?: string } {
    try {
      fs.rmSync(this.geminiSystemSettingsPath(), { force: true });
      for (const x of this.data.gemini.profiles) x.active = false;
      this.saveKind('gemini');
      this.broadcast();
      this.applied('gemini');
      return { ok: true, backups: [] };
    } catch (e) {
      return { ok: false, backups: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 停用 dsh 供应商：移除 Nomi 区块，回到 dsh 自身的默认供应商 */
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
      this.applied('dsh');
      return { ok: true, backups };
    } catch (e) {
      return { ok: false, backups, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 停用某个后端的供应商：只移除 Nomi 写入的连接字段，回到 CLI 自带登录 / 默认配置。
   * 先备份；其余内容原样保留。
   */
  /** 停用 Grok 供应商：移除 Nomi 标记区块，回到 Grok 自身登录 / 默认配置 */
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
      this.applied('grok');
      return { ok: true, backups };
    } catch (e) {
      return { ok: false, backups, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 该 CLI 是否启用了 Nomi 的第三方供应商（切到官方账号时据此决定要不要停用） */
  hasActiveProfile(kind: CliProviderKind): boolean {
    return this.data[kind].profiles.some((x) => x.active);
  }

  deactivate(kind: CliProviderKind): { ok: boolean; backups: string[]; error?: string } {
    if (kind === 'dsh') return this.deactivateDsh();
    if (kind === 'grok') return this.deactivateGrok();
    if (kind === 'gemini') return this.deactivateGemini();
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
      this.applied(kind);
      return { ok: true, backups };
    } catch (e) {
      return { ok: false, backups, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 该 CLI 启用中的供应商（编程助手标签的模型按钮按它列模型、按它区分标签的模型选择） */
  activeProfile(kind: CliProviderKind): { id: string; name: string; model: string } | null {
    const p = this.data[kind].profiles.find((x) => x.active);
    return p ? { id: p.id, name: p.name, model: p.model } : null;
  }

  /**
   * 启用中供应商的上游模型列表（与测速同一个只读 GET，用供应商自己保存的密钥）。
   * 上游没有列表接口（404 / 405）时返回空列表；鉴权失败等抛出可读错误，错误里的密钥会被抹掉。
   */
  async listModels(kind: CliProviderKind): Promise<string[]> {
    const p = this.data[kind].profiles.find((x) => x.active);
    if (!p) return [];
    const key = decrypt(p.keyEnc);
    const req = buildProbeRequest(p.apiFormat, p.baseUrl, key);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(req.url, { method: 'GET', headers: req.headers, signal: ctl.signal });
      if (res.status === 404 || res.status === 405) return [];
      if (res.status < 200 || res.status >= 300)
        throw new Error(
          res.status === 401 || res.status === 403
            ? t('Key 无效或无权限（HTTP {0}）', res.status)
            : t('上游返回 HTTP {0}', res.status),
        );
      return parseModelList(await res.json());
    } catch (e) {
      const msg = ctl.signal.aborted ? t('连接超时（8 秒）') : String((e as Error).message ?? e);
      throw new Error(key ? msg.split(key).join('••••') : msg, { cause: e });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * dsh：标签选了别的模型时，给那个进程用的叠加配置（`dsh --patch`）。
   * 叠加会整段替换供应商定义，所以带上完整的 api / baseURL / 密钥变量，只把模型换掉。
   */
  dshPatchFor(model: string): string | null {
    const p = this.data.dsh.profiles.find((x) => x.active);
    if (!p || !isDshApiFormat(p.apiFormat)) return null;
    return patchDshYaml(null, { api: dshApiName(p.apiFormat), baseURL: p.baseUrl, model });
  }

  /**
   * 测速：对供应商的上游发一次轻量的模型列表请求，只测连通性 / 鉴权 / 延迟，不发对话。
   * Key 只在主进程里使用；错误信息里的 Key 会被抹掉。
   */
  async testProfile(id: string): Promise<CliProfileTestResult> {
    const p = this.allProfiles().find((x) => x.id === id);
    if (!p) throw new Error(t('供应商不存在'));
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
      geminiStore: this.storePaths.gemini,
      geminiConfig: this.geminiSystemSettingsPath(),
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
    if (existing?.active) {
      // 正在使用的供应商：保存 = 在主进程里一次性「预检 → 写 CLI 配置 → 落盘第三方供应商列表」（#39）。
      // 不再依赖渲染层随后再发 activate：两步之间窗口关闭 / IPC 失败 / 恰好拉起一轮 CLI 时，
      // 启动环境会用新 Key 配旧端点。activate 是同步的，中途不会有别的轮次读到半新半旧的供应商；
      // 写盘失败时由 rollbacks 快照恢复内存与第三方供应商列表，新 Key 从未落盘。
      const problem = this.preflight(next);
      if (problem) throw new Error(problem);
      this.rollbacks.set(id, { ...existing });
      Object.assign(existing, next);
      const r = this.activate(id);
      if (!r.ok) throw new Error(r.error ?? t('启用失败'));
      return this.toView(existing);
    }
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
    /** 失败后已把「正在使用的供应商」恢复为编辑前的完整配置 */
    rolledBack?: boolean;
  } {
    const p = this.allProfiles().find((x) => x.id === id);
    if (!p) {
      return {
        ok: false,
        backups: [],
        restartRequired: false,
        usedRouting: false,
        error: t('供应商不存在'),
      };
    }
    const failure = (error: string) => {
      const rolledBack = this.rollBackActiveEdit(id);
      return {
        ok: false,
        backups: [] as string[],
        restartRequired: false,
        usedRouting: false,
        error: rolledBack ? withRestoredNote(error) : error,
        ...(rolledBack ? { rolledBack } : {}),
      };
    };
    const problem = this.preflight(p);
    if (problem) return failure(problem);
    const key = decrypt(p.keyEnc);
    const needs = formatNeedsRouting(p.kind, p.apiFormat);
    const route = getCliRouteService();
    const useRoute = needs;
    // 本地路由令牌：CLI 请求本地路由时必须携带（路由不再接受任意来源的匿名请求）
    const routeKey = route?.authToken() ?? 'nomi-route';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backups: string[] = [];
    try {
      if (p.kind === 'gemini') {
        const selectedType = p.baseUrl.trim() ? 'gateway' : 'gemini-api-key';
        ensureDir(this.geminiSystemSettingsPath());
        writePrivateFile(
          this.geminiSystemSettingsPath(),
          JSON.stringify({ security: { auth: { selectedType } } }, null, 2),
        );
      } else if (p.kind === 'dsh') {
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
      this.rollbacks.delete(id);
      this.saveKind(p.kind);
      this.broadcast();
      // 下一轮会自己拉起新进程读这份配置，不再提示用户重启会话。
      this.applied(p.kind);
      return {
        ok: true,
        backups,
        restartRequired: false,
        usedRouting: Boolean(useRoute),
      };
    } catch (e) {
      const error =
        e instanceof GrokInlineModelsError
          ? t('~/.grok/config.toml 用内联表定义了 models，请改成 [models] 表后再启用')
          : e instanceof Error
            ? e.message
            : String(e);
      // 写到一半失败（如 Codex 的 config 已写、auth 没写成）：把已备份的原文件放回去，
      // 避免 CLI 配置文件之间互相混配
      if (backups.length) this.restoreBackup(ts);
      const rolledBack = this.rollBackActiveEdit(id);
      return {
        ok: false,
        backups,
        restartRequired: false,
        usedRouting: false,
        error: rolledBack ? withRestoredNote(error) : error,
        ...(rolledBack ? { rolledBack } : {}),
      };
    }
  }

  /** 激活 / 保存前的共同预检：返回问题描述，null 表示可以写入 */
  private preflight(p: StoredProfile): string | null {
    const route = getCliRouteService();
    const routeSettings = route?.getSettings();
    const routingOn = Boolean(
      p.kind !== 'dsh' &&
      p.kind !== 'grok' &&
      p.kind !== 'gemini' &&
      routeSettings?.enabled &&
      routeSettings?.[p.kind as 'claude' | 'codex'],
    );
    if (formatNeedsRouting(p.kind, p.apiFormat) && !routingOn) {
      return t('该上游格式需要先开启本地路由（高级设置）');
    }
    // dsh / Grok 会把模型写进自己的默认路由。空字符串会盖掉 CLI 自带默认，
    // 下一轮直接报 “has no provider/model”。
    if ((p.kind === 'dsh' || p.kind === 'grok') && !p.model.trim()) {
      return t('请先填写模型，再设为当前');
    }
    return null;
  }

  /** 激活失败：若该供应商是「正在使用且刚被编辑」的，恢复编辑前的完整快照，返回是否恢复了 */
  private rollBackActiveEdit(id: string): boolean {
    const snap = this.rollbacks.get(id);
    this.rollbacks.delete(id);
    if (!snap) return false;
    const cur = this.data[snap.kind].profiles.find((x) => x.id === id);
    if (!cur) return false;
    Object.assign(cur, snap);
    this.saveKind(snap.kind);
    this.broadcast();
    return true;
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
      if (!KINDS.includes(k as CliProviderKind)) throw new Error(t('供应商不存在'));
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
