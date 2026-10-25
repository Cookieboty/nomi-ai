/**
 * 撤销旧版本写进 CLI 全局配置的第三方设置（docs/design/unified-gateway.md §6.3 第 7 步）。
 * 现在第三方会话由网关按进程注入，终端里直接运行的 CLI 应回到用户自己的配置和官方登录。
 *
 * 只处理旧存储里有「启用中」第三方供应商的 CLI，只删 Nomi 当初写入的内容：
 * - Claude：~/.claude/settings.json 的 env 里值等于 Nomi 写入值的 ANTHROPIC_API_KEY / BASE_URL / MODEL；
 * - Codex：[model_providers.nomi]、model_provider = "nomi"、等于旧模型的顶层 model；
 *   auth.json 只删等于 Nomi 写入值的 OPENAI_API_KEY，tokens 等官方登录字段不动；
 * - Grok / dsh：带 `nomi managed` 标记的区块（Grok 的 [models].default 按记录还原）；
 * - Gemini：Nomi 私有的 cli-providers/gemini/system-settings.json。
 * 改动前备份到 backupRoot/<时间戳>/；某个 CLI 失败时原文件不动，记进 failed，继续其他 CLI。
 *
 * 幂等：
 * - 每个 CLI 撤销成功后把它旧存储里的供应商标为未启用，下次不会再处理它；
 * - 全部成功（或本来就没有要撤销的）后写 cliRoot/.revoked 标记，之后直接返回 skipped；
 * - 有失败时不写标记：下次启动只重试仍处于启用状态（即失败）的 CLI。
 * 不碰：~/.claude.json、钥匙串、~/.codex/auth.json 的 tokens、~/.grok/auth.json、~/.gemini/*、
 * 官方账号保险箱 userData/cli-accounts/*。
 */
import fs from 'fs';
import path from 'path';

import { urlHost } from '@nomi-ai/gateway';

import {
  backupFile,
  claudeSettingsPath,
  codexAuthPath,
  codexConfigPath,
  dshPatchPath,
  grokConfigPath,
  patchClaudeSettings,
  patchDshYaml,
  patchGrokToml,
  unpatchCodexAuth,
  unpatchCodexToml,
} from '../cli/configPatch';
import type { CliProviderKind } from '../cli/types';
import { t as tr } from '../i18n';
import { writePrivateFile } from '../utils/privateFile';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

export type LegacyKind = CliProviderKind;

export const LEGACY_KINDS: readonly LegacyKind[] = ['claude', 'codex', 'dsh', 'grok', 'gemini'];

/** 全部撤销完成后写入的标记文件名（位于 cliRoot 下） */
export const REVOKED_MARKER = '.revoked';

const DEFAULT_ROUTE_PORT = 18721;
const ROUTE_TOKEN_RE = /^nomi-route-[0-9a-f]{48}$/;
/** 旧版本拿不到路由服务时写入的占位令牌 */
const ROUTE_TOKEN_FALLBACK = 'nomi-route';

export interface RevokeLegacyOptions {
  home: string;
  /** userData/cli-providers */
  cliRoot: string;
  /** userData/gateway/backups */
  backupRoot: string;
  decrypt: (enc: string) => string;
  logger: Logger;
  now?: () => number;
  /** 解析 DSH_HOME / GROK_HOME，默认 process.env */
  env?: NodeJS.ProcessEnv;
}

export interface RevokeLegacyResult {
  revoked: LegacyKind[];
  failed: Array<{ kind: LegacyKind; error: string }>;
  /** 已撤销过（有标记），或没有任何 CLI 启用旧第三方供应商 */
  skipped: boolean;
}

interface LegacyProfile {
  baseUrl?: unknown;
  model?: unknown;
  keyEnc?: unknown;
  active?: unknown;
}

interface LegacyStore {
  file: string;
  data: { profiles: LegacyProfile[] } & Record<string, unknown>;
  active: LegacyProfile;
}

/** 本次要写的文件：先全部算好再统一备份、写入，避免改到一半 */
interface Change {
  file: string;
  label: string;
  /** null = 删除 */
  next: string | null;
  private?: boolean;
}

class RevokeError extends Error {}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');

/** 旧存储：迁移后可能已改名为 store.json.migrated（§6.3 第 5 步） */
function readStore(cliRoot: string, kind: LegacyKind): LegacyStore | null {
  for (const name of ['store.json', 'store.json.migrated']) {
    const file = path.join(cliRoot, kind, name);
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as LegacyStore['data'];
      if (!data || !Array.isArray(data.profiles)) return null;
      const active = data.profiles.find((p) => p && p.active === true);
      return active ? { file, data, active } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function routeInfo(cliRoot: string): { tokens: string[]; bases: string[] } {
  const tokens = [ROUTE_TOKEN_FALLBACK];
  try {
    const raw = fs.readFileSync(path.join(cliRoot, 'routing.token'), 'utf8').trim();
    if (ROUTE_TOKEN_RE.test(raw)) tokens.push(raw);
  } catch {
    /* 没用过本地路由 */
  }
  let port = DEFAULT_ROUTE_PORT;
  let host = '127.0.0.1';
  try {
    const r = JSON.parse(fs.readFileSync(path.join(cliRoot, 'routing.json'), 'utf8')) as {
      port?: unknown;
      host?: unknown;
    };
    if (typeof r.port === 'number' && r.port > 0 && r.port < 65536) port = Math.floor(r.port);
    if (typeof r.host === 'string' && r.host.trim()) host = r.host.trim();
  } catch {
    /* 默认端口 */
  }
  const bases = [...new Set([host, '127.0.0.1', 'localhost', '::1'])].flatMap((h) => {
    const base = `http://${urlHost(h)}:${port}`;
    return [base, `${base}/v1`];
  });
  return { tokens, bases };
}

function readText(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new RevokeError(
      tr('electron.common.cannot-read', file, e instanceof Error ? e.message : String(e)),
    );
  }
}

function parseJsonObject(file: string, raw: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj))
      return obj as Record<string, unknown>;
  } catch {
    /* 下面统一报错 */
  }
  throw new RevokeError(tr('electron.common.could-not-be-parsed-and-was-left-unchanged', file));
}

function planClaude(
  o: RevokeLegacyOptions,
  p: LegacyProfile,
  route: { tokens: string[]; bases: string[] },
): Change[] {
  const file = claudeSettingsPath(o.home);
  const raw = readText(file);
  if (raw === null) return [];
  const obj = parseJsonObject(file, raw);
  const env = obj.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [];
  const e = env as Record<string, unknown>;
  const key = o.decrypt(str(p.keyEnc));
  const keys = new Set([...route.tokens, ...(key ? [key] : [])]);
  const bases = new Set([...route.bases, trimSlash(str(p.baseUrl))].filter(Boolean).map(trimSlash));
  const model = str(p.model);
  const remove: Record<string, undefined> = {};
  if (typeof e.ANTHROPIC_API_KEY === 'string' && keys.has(e.ANTHROPIC_API_KEY))
    remove.ANTHROPIC_API_KEY = undefined;
  if (typeof e.ANTHROPIC_BASE_URL === 'string' && bases.has(trimSlash(e.ANTHROPIC_BASE_URL)))
    remove.ANTHROPIC_BASE_URL = undefined;
  if (model && e.ANTHROPIC_MODEL === model) remove.ANTHROPIC_MODEL = undefined;
  if (!Object.keys(remove).length) return [];
  return [
    {
      file,
      label: 'claude-settings.json',
      next: patchClaudeSettings(raw, remove),
      private: true,
    },
  ];
}

function planCodex(
  o: RevokeLegacyOptions,
  p: LegacyProfile,
  route: { tokens: string[] },
): Change[] {
  const changes: Change[] = [];
  const conf = codexConfigPath(o.home);
  const rawConf = readText(conf);
  if (rawConf !== null) {
    const hasNomi =
      /^\s*\[\s*model_providers\.nomi\s*\]/m.test(rawConf) ||
      /^\s*model_provider\s*=\s*"nomi"\s*$/m.test(rawConf);
    if (hasNomi) {
      let next = unpatchCodexToml(rawConf);
      // patchCodexToml 同时把顶层 model 改成了旧供应商的模型：等于该值时一并去掉，回到 Codex 默认
      const model = str(p.model);
      if (model) next = dropTopLevelModel(next, model);
      changes.push({ file: conf, label: 'codex-config.toml', next });
    }
  }
  const auth = codexAuthPath(o.home);
  const rawAuth = readText(auth);
  if (rawAuth !== null) {
    const obj = parseJsonObject(auth, rawAuth);
    const key = o.decrypt(str(p.keyEnc));
    const written = new Set([...route.tokens, ...(key ? [key] : [])]);
    const current = obj.OPENAI_API_KEY;
    if (typeof current === 'string' && written.has(current)) {
      const next = unpatchCodexAuth(rawAuth, current);
      if (next !== null)
        changes.push({ file: auth, label: 'codex-auth.json', next, private: true });
    }
  }
  return changes;
}

/** 去掉首个表头之前、值等于 model 的顶层 `model = "…"` 行 */
function dropTopLevelModel(raw: string, model: string): string {
  const quoted = JSON.stringify(model);
  const lines = raw.split('\n');
  const out: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('[')) inTable = true;
    if (!inTable && /^model\s*=/.test(t) && t.replace(/^model\s*=\s*/, '') === quoted) continue;
    out.push(line);
  }
  return out.join('\n');
}

function planMarked(
  file: string,
  label: string,
  marker: string,
  unpatch: (raw: string) => string,
): Change[] {
  const raw = readText(file);
  if (raw === null || !raw.includes(marker)) return [];
  const next = unpatch(raw);
  return next === raw ? [] : [{ file, label, next }];
}

function planGemini(o: RevokeLegacyOptions): Change[] {
  const file = path.join(o.cliRoot, 'gemini', 'system-settings.json');
  return fs.existsSync(file) ? [{ file, label: 'gemini-system-settings.json', next: null }] : [];
}

function plan(
  kind: LegacyKind,
  o: RevokeLegacyOptions,
  p: LegacyProfile,
  route: { tokens: string[]; bases: string[] },
): Change[] {
  const env = o.env ?? process.env;
  switch (kind) {
    case 'claude':
      return planClaude(o, p, route);
    case 'codex':
      return planCodex(o, p, route);
    case 'dsh':
      return planMarked(dshPatchPath(o.home, env), 'dsh-cordis.patch.yml', 'nomi managed', (r) =>
        patchDshYaml(r, null),
      );
    case 'grok':
      return planMarked(grokConfigPath(o.home, env), 'grok-config.toml', 'nomi managed', (r) =>
        patchGrokToml(r, null),
      );
    case 'gemini':
      return planGemini(o);
  }
}

/** 备份后写入；中途失败把已写的文件从备份放回去 */
function apply(changes: Change[], backupDir: string): void {
  const done: Array<{ change: Change; backup: string | null }> = [];
  for (const c of changes) {
    const backup = backupFile(c.file, backupDir, c.label);
    done.push({ change: c, backup });
  }
  const written: typeof done = [];
  try {
    for (const d of done) {
      const c = d.change;
      if (c.next === null) fs.rmSync(c.file, { force: true });
      else if (c.private) writePrivateFile(c.file, c.next);
      else fs.writeFileSync(c.file, c.next, 'utf8');
      written.push(d);
    }
  } catch (e) {
    for (const d of written) {
      try {
        if (d.backup) fs.copyFileSync(d.backup, d.change.file);
      } catch {
        /* 尽力还原 */
      }
    }
    throw new RevokeError(
      tr(
        'electron.common.cannot-write',
        changes[written.length]?.file ?? '',
        e instanceof Error ? e.message : String(e),
      ),
    );
  }
}

function markInactive(store: LegacyStore): void {
  for (const p of store.data.profiles) if (p && typeof p === 'object') p.active = false;
  writePrivateFile(store.file, JSON.stringify(store.data, null, 2));
}

function writeMarker(o: RevokeLegacyOptions, revoked: LegacyKind[], at: number): void {
  if (!fs.existsSync(o.cliRoot)) return;
  try {
    writePrivateFile(
      path.join(o.cliRoot, REVOKED_MARKER),
      JSON.stringify({ version: 1, revokedAt: new Date(at).toISOString(), revoked }, null, 2),
    );
  } catch (e) {
    o.logger.warn('legacy revoke marker write failed', e);
  }
}

export function revokeLegacyGlobalConfig(opts: RevokeLegacyOptions): RevokeLegacyResult {
  const result: RevokeLegacyResult = { revoked: [], failed: [], skipped: false };
  if (fs.existsSync(path.join(opts.cliRoot, REVOKED_MARKER))) return { ...result, skipped: true };

  const at = (opts.now ?? Date.now)();
  const stores = LEGACY_KINDS.map((kind) => ({ kind, store: readStore(opts.cliRoot, kind) }));
  const todo = stores.filter((s): s is { kind: LegacyKind; store: LegacyStore } => !!s.store);
  if (!todo.length) {
    writeMarker(opts, [], at);
    return { ...result, skipped: true };
  }

  const route = routeInfo(opts.cliRoot);
  const backupDir = path.join(opts.backupRoot, new Date(at).toISOString().replace(/[:.]/g, '-'));
  for (const { kind, store } of todo) {
    try {
      apply(plan(kind, opts, store.active, route), backupDir);
      markInactive(store);
      result.revoked.push(kind);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const error =
        e instanceof RevokeError
          ? detail
          : tr('electron.common.failed-to-revoke-the-old-configuration', kind, detail);
      opts.logger.warn('legacy global config revoke failed', { kind, error });
      result.failed.push({ kind, error });
    }
  }
  if (!result.failed.length) writeMarker(opts, result.revoked, at);
  opts.logger.info('legacy global config revoked', {
    revoked: result.revoked,
    failed: result.failed.map((f) => f.kind),
  });
  return result;
}
