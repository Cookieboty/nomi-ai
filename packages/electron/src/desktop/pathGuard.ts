/**
 * 路径守卫（纯逻辑，便于单测）：所有桌面工具访问文件系统前都必须经过这里。
 *
 * 1. 语法：拒绝空 / 超长 / NUL / 相对路径 / UNC（\\server\share、//server）/ 设备路径（\\?\、\\.\、/dev、/proc、/sys）
 * 2. 作用域：realpath(目标) 必须位于某个已授权作用域的 realpath 之内（path.relative 不以 .. 开头、不是绝对路径）；
 *    词法上在作用域内但 realpath 跑到外面 → symlink_escape
 * 3. 硬性黑名单：即使在作用域内也拒绝（.ssh、钥匙串、浏览器配置、*.kdbx、id_rsa、.env…、应用自身数据目录）
 * 4. 模式：写操作要求作用域为 read-write；单文件作用域只允许该文件本身
 */
import * as nodePath from 'path';

import { t } from '../i18n';

export type GuardCode =
  'invalid_path' | 'outside_scope' | 'denied' | 'symlink_escape' | 'read_only' | 'not_found';

export interface Scope {
  id: string;
  path: string;
  mode: 'read' | 'read-write';
  kind: 'folder' | 'file';
  grantedAt: number;
  /** 拖到看板娘身上的单个文件：仅本次运行有效 */
  session?: boolean;
}

export interface GuardOk {
  ok: true;
  /** 真实路径（realpath 之后） */
  real: string;
  scope: Scope;
  exists: boolean;
}

export interface GuardErr {
  ok: false;
  code: GuardCode;
  message: string;
}

export type GuardResult = GuardOk | GuardErr;

export interface GuardEnv {
  scopes: Scope[];
  home: string;
  platform: NodeJS.Platform;
  /** fs.promises.realpath；不存在时应抛 ENOENT */
  realpath: (p: string) => Promise<string>;
  /** 额外拒绝的根目录（如应用 userData） */
  denyRoots?: string[];
}

const MAX_PATH = 4096;

/** 路径段黑名单（任意一段命中即拒绝，大小写不敏感） */
export const DENY_SEGMENTS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
  'keychains',
  '.mozilla',
  'google-chrome',
  'chromium',
  'bravesoftware',
  '.gcloud',
  'gcloud',
];

/** 路径片段黑名单（规范化为小写 + 正斜杠后包含即拒绝） */
export const DENY_FRAGMENTS = [
  '/library/application support/google/chrome',
  '/library/application support/firefox',
  '/library/application support/microsoft edge',
  '/appdata/local/google/chrome',
  '/appdata/local/microsoft/edge',
  '/appdata/roaming/mozilla',
  '/appdata/local/microsoft/credentials',
  '/appdata/roaming/microsoft/credentials',
  '/appdata/roaming/microsoft/protect',
];

/** 文件名黑名单 */
export const DENY_NAMES: RegExp[] = [
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.kdbx?$/i,
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^login\.keychain(-db)?$/i,
];

function lib(platform: NodeJS.Platform): typeof nodePath.posix {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

const caseInsensitive = (platform: NodeJS.Platform) =>
  platform === 'win32' || platform === 'darwin';

/** 语法检查 + ~ 展开 + 规范化；失败返回 GuardErr */
export function normalizeInput(
  input: unknown,
  home: string,
  platform: NodeJS.Platform,
): string | GuardErr {
  const bad = (message: string): GuardErr => ({ ok: false, code: 'invalid_path', message });
  if (typeof input !== 'string' || !input.trim()) return bad(t('electron.common.path-is-empty'));
  let p = input.trim();
  if (p.length > MAX_PATH) return bad(t('electron.common.path-too-long'));
  if (p.includes('\0')) return bad(t('electron.common.path-contains-invalid-characters'));
  if (/^[\\/]{2}/.test(p))
    return bad(t('electron.common.network-device-paths-unc-aren-t-supported'));
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return bad(t('electron.common.device-paths-aren-t-supported'));
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = home + p.slice(1);
  const P = lib(platform);
  if (!P.isAbsolute(p)) return bad(t('electron.common.must-be-an-absolute-path-or-start-with'));
  if (platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(p))
    return bad(t('electron.common.windows-paths-must-include-a-drive-letter'));
  const norm = P.resolve(p);
  const lower = norm.replace(/\\/g, '/').toLowerCase();
  if (platform !== 'win32' && /^\/(dev|proc|sys)(\/|$)/.test(lower))
    return bad(t('electron.common.device-paths-aren-t-supported'));
  return norm;
}

/** child 是否在 parent 之内（含相等） */
export function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const P = lib(platform);
  let c = P.resolve(child);
  let pa = P.resolve(parent);
  if (caseInsensitive(platform)) {
    c = c.toLowerCase();
    pa = pa.toLowerCase();
  }
  if (c === pa) return true;
  const rel = P.relative(pa, c);
  return !!rel && !rel.startsWith('..') && !P.isAbsolute(rel);
}

/** 黑名单检查；命中返回原因 */
export function denyReason(
  p: string,
  platform: NodeJS.Platform,
  denyRoots: string[] = [],
): string | null {
  for (const root of denyRoots)
    if (root && isInside(p, root, platform)) return t('electron.common.app-private-data-folder');
  const norm = p.replace(/\\/g, '/').toLowerCase();
  const segs = norm.split('/').filter(Boolean);
  for (const s of segs)
    if (DENY_SEGMENTS.includes(s)) return t('electron.common.protected-folder', s);
  for (const f of DENY_FRAGMENTS)
    if (norm.includes(f)) return t('electron.common.browser-system-credential-folder');
  const name = segs[segs.length - 1] ?? '';
  for (const re of DENY_NAMES) if (re.test(name)) return t('electron.common.protected-file', name);
  return null;
}

async function realOrParent(
  p: string,
  env: GuardEnv,
): Promise<{ real: string; exists: boolean } | null> {
  try {
    return { real: await env.realpath(p), exists: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return null;
    const P = lib(env.platform);
    const parent = P.dirname(p);
    if (parent === p) return null;
    try {
      return { real: P.join(await env.realpath(parent), P.basename(p)), exists: false };
    } catch {
      return null;
    }
  }
}

export async function guardPath(
  input: unknown,
  env: GuardEnv,
  opts: { need: 'read' | 'write'; allowMissing?: boolean } = { need: 'read' },
): Promise<GuardResult> {
  const norm = normalizeInput(input, env.home, env.platform);
  if (typeof norm !== 'string') return norm;
  const lexicalDeny = denyReason(norm, env.platform, env.denyRoots);
  if (lexicalDeny)
    return { ok: false, code: 'denied', message: t('electron.common.access-denied', lexicalDeny) };

  const lexicalScope = env.scopes.find((s) =>
    s.kind === 'file'
      ? isInside(norm, s.path, env.platform) && isInside(s.path, norm, env.platform)
      : isInside(norm, s.path, env.platform),
  );
  const resolved = await realOrParent(norm, env);
  if (!resolved) {
    return lexicalScope
      ? {
          ok: false,
          code: 'not_found',
          message: t('electron.common.file-or-its-parent-folder-doesn-t-exist'),
        }
      : {
          ok: false,
          code: 'outside_scope',
          message: t('electron.common.path-is-not-inside-a-granted-folder'),
        };
  }
  if (!resolved.exists && !opts.allowMissing) {
    return lexicalScope
      ? { ok: false, code: 'not_found', message: t('electron.common.file-doesn-t-exist') }
      : {
          ok: false,
          code: 'outside_scope',
          message: t('electron.common.path-is-not-inside-a-granted-folder'),
        };
  }
  const realDeny = denyReason(resolved.real, env.platform, env.denyRoots);
  if (realDeny)
    return { ok: false, code: 'denied', message: t('electron.common.access-denied', realDeny) };

  for (const s of env.scopes) {
    let scopeReal: string;
    try {
      scopeReal = await env.realpath(s.path);
    } catch {
      continue; // 作用域目录已不存在
    }
    const inside =
      s.kind === 'file'
        ? isInside(resolved.real, scopeReal, env.platform) &&
          isInside(scopeReal, resolved.real, env.platform)
        : isInside(resolved.real, scopeReal, env.platform);
    if (!inside) continue;
    if (opts.need === 'write' && s.mode !== 'read-write') {
      return {
        ok: false,
        code: 'read_only',
        message: t('electron.common.this-folder-is-granted-read-only'),
      };
    }
    return { ok: true, real: resolved.real, scope: s, exists: resolved.exists };
  }
  if (lexicalScope) {
    return {
      ok: false,
      code: 'symlink_escape',
      message: t('electron.common.symlink-points-outside-the-granted-scope'),
    };
  }
  return {
    ok: false,
    code: 'outside_scope',
    message: t('electron.common.path-is-not-inside-a-granted-folder'),
  };
}
