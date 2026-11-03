/**
 * 第三方供应商链接（docs/design/provider-link.md）的纯逻辑：解析 `nomi://provider/*`、校验负载 /
 * 授权清单 / 换 Key 返回、PKCE。Go 版 apps/desktop-go/internal/core/providerlink 逐个对应，
 * 两边跑同一份用例（tests/fixtures/provider-link-cases.json）。
 */
import { createHash, randomBytes } from 'crypto';

import { isPrivateHost } from '@nomi-ai/gateway';

export const LINK_WIRES = ['chat', 'responses', 'messages', 'gemini'] as const;
export type LinkWire = (typeof LINK_WIRES)[number];

/** 整条链接的长度上限 */
export const LINK_MAX = 16384;
export const NAME_MAX = 64;
export const MODELS_MAX = 200;
export const REDIRECT_URI = 'nomi://provider/callback';
export const CLIENT_ID = 'nomi';

export type LinkErrorCode =
  | 'bad_link'
  | 'too_long'
  | 'bad_payload'
  | 'bad_name'
  | 'bad_url'
  | 'bad_key'
  | 'bad_issuer'
  | 'bad_manifest'
  | 'bad_token'
  | 'bad_state'
  | 'denied'
  | 'network';

export type LinkResult<T> = { ok: true; value: T } | { ok: false; code: LinkErrorCode };

/** 一个待保存的第三方供应商（Key 明文，只在内核里） */
export interface LinkProvider {
  name: string;
  homepage?: string;
  urls: Partial<Record<LinkWire, string>>;
  key: string;
  models: string[];
}

export interface LinkManifest {
  issuer: string;
  name: string;
  homepage?: string;
  urls: Partial<Record<LinkWire, string>>;
  models: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export type ParsedLink =
  | { kind: 'import'; provider: LinkProvider }
  | { kind: 'connect'; issuer: string }
  | { kind: 'callback'; state: string; code?: string; error?: string };

const ok = <T>(value: T): LinkResult<T> => ({ ok: true, value });
const fail = <T>(code: LinkErrorCode): LinkResult<T> => ({ ok: false, code });

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** 去掉控制字符、合并空白、按码点截到 max */
export function cleanName(raw: unknown, max = NAME_MAX): string {
  const s = (str(raw) ?? '')
    // eslint-disable-next-line no-control-regex -- 就是要去掉控制字符
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, max).join('');
}

/** https、不带用户名密码、不指向本机 / 局域网；通过时返回去掉首尾空白的原串 */
export function checkUrl(raw: unknown): string | null {
  const s = (str(raw) ?? '').trim();
  if (!s || s.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
  if (isPrivateHost(u.hostname)) return null;
  return s;
}

/** issuer：只能是 https 源（不带路径 / 查询 / 片段），返回规范的 origin */
export function normalizeIssuer(raw: unknown): string | null {
  const s = checkUrl(raw);
  if (!s) return null;
  const u = new URL(s);
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
  return u.origin;
}

const KEY_RE = /^[\x21-\x7e]{8,512}$/;
const MODEL_RE = /^[\x21-\x7e]{1,128}$/;

function cleanKey(raw: unknown): string | null {
  const k = (str(raw) ?? '').trim();
  return KEY_RE.test(k) ? k : null;
}

function cleanModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const m of raw) {
    const id = (str(m) ?? '').trim();
    if (MODEL_RE.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MODELS_MAX) break;
  }
  return out;
}

/** urls 对象：只认四种协议；有一个不合法就整体不合法；allowEmpty 为 false 时至少要有一个 */
function cleanUrls(raw: unknown, allowEmpty: boolean): Partial<Record<LinkWire, string>> | null {
  if (raw === undefined && allowEmpty) return {};
  if (!isObj(raw)) return null;
  const out: Partial<Record<LinkWire, string>> = {};
  for (const w of LINK_WIRES) {
    if (raw[w] === undefined || raw[w] === null || raw[w] === '') continue;
    const u = checkUrl(raw[w]);
    if (!u) return null;
    out[w] = u;
  }
  if (!allowEmpty && !Object.keys(out).length) return null;
  return out;
}

/** Cherry Studio 负载的 type → 网关协议（其余按 OpenAI Chat） */
const CHERRY_TYPE_WIRE: Record<string, LinkWire> = { anthropic: 'messages', gemini: 'gemini' };

/** 导入负载：Nomi 自己的写法，或 Cherry Studio 的扁平写法（baseUrl / apiKey / type） */
export function normalizeProvider(raw: unknown): LinkResult<LinkProvider> {
  if (!isObj(raw)) return fail('bad_payload');
  const name = cleanName(raw.name);
  if (!name) return fail('bad_name');
  let urls: Partial<Record<LinkWire, string>> | null;
  if (raw.urls !== undefined) urls = cleanUrls(raw.urls, false);
  else if (raw.baseUrl !== undefined) {
    const u = checkUrl(raw.baseUrl);
    const type = (str(raw.type) ?? '').toLowerCase();
    const wire: LinkWire = CHERRY_TYPE_WIRE[type] ?? 'chat';
    urls = u ? { [wire]: u } : null;
  } else urls = null;
  if (!urls) return fail('bad_url');
  const key = cleanKey(raw.key ?? raw.apiKey ?? raw.api_key);
  if (!key) return fail('bad_key');
  const homepage = checkUrl(raw.homepage) ?? undefined;
  return ok({
    name,
    ...(homepage ? { homepage } : {}),
    urls,
    key,
    models: cleanModels(raw.models),
  });
}

const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function decodeData(data: string): unknown {
  if (!B64_RE.test(data)) return undefined;
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (b64.length % 4 === 1) return undefined;
  const text = Buffer.from(b64, 'base64').toString('utf8');
  if (text.includes('�')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** 解析 `nomi://provider/<action>?…` */
export function parseProviderLink(raw: string): LinkResult<ParsedLink> {
  if (typeof raw !== 'string') return fail('bad_link');
  if (raw.length > LINK_MAX) return fail('too_long');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return fail('bad_link');
  }
  if (u.protocol !== 'nomi:' || u.hostname.toLowerCase() !== 'provider') return fail('bad_link');
  const action = u.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  const q = u.searchParams;
  const v = q.get('v');
  if (v !== null && v !== '1') return fail('bad_link');
  if (action === 'import') {
    // 网页没给 + 转义时，查询串里的 + 会被读成空格：换回来
    const data = q.get('data')?.replace(/ /g, '+');
    if (!data) return fail('bad_payload');
    const payload = decodeData(data);
    if (payload === undefined) return fail('bad_payload');
    const p = normalizeProvider(payload);
    return p.ok ? ok({ kind: 'import', provider: p.value }) : p;
  }
  if (action === 'connect') {
    const issuer = normalizeIssuer(q.get('issuer'));
    return issuer ? ok({ kind: 'connect', issuer }) : fail('bad_issuer');
  }
  if (action === 'callback') {
    const state = q.get('state') ?? '';
    if (!STATE_RE.test(state)) return fail('bad_state');
    const code = q.get('code') ?? '';
    const error = q.get('error') ?? '';
    if (!code && !error) return fail('bad_link');
    return ok({
      kind: 'callback',
      state,
      ...(code ? { code: code.slice(0, 2048) } : {}),
      ...(error ? { error: error.slice(0, 64) } : {}),
    });
  }
  return fail('bad_link');
}

/** 授权 / 换 Key 端点：https，主机是 issuer 的主机或它的子域名 */
function checkEndpoint(raw: unknown, issuer: string): string | null {
  const s = checkUrl(raw);
  if (!s) return null;
  const host = new URL(s).hostname.toLowerCase();
  const root = new URL(issuer).hostname.toLowerCase();
  return host === root || host.endsWith(`.${root}`) ? s : null;
}

/** `/.well-known/nomi-provider.json` */
export function parseManifest(raw: unknown, issuer: string): LinkResult<LinkManifest> {
  if (!isObj(raw)) return fail('bad_manifest');
  if (raw.version !== undefined && raw.version !== 1) return fail('bad_manifest');
  const urls = cleanUrls(raw.urls, true);
  if (!urls) return fail('bad_manifest');
  const authorizationEndpoint = checkEndpoint(raw.authorization_endpoint, issuer);
  const tokenEndpoint = checkEndpoint(raw.token_endpoint, issuer);
  if (!authorizationEndpoint || !tokenEndpoint) return fail('bad_manifest');
  const homepage = checkUrl(raw.homepage) ?? undefined;
  return ok({
    issuer,
    name: cleanName(raw.name) || new URL(issuer).hostname,
    ...(homepage ? { homepage } : {}),
    urls,
    models: cleanModels(raw.models),
    authorizationEndpoint,
    tokenEndpoint,
  });
}

/** 换 Key 的返回 → 待保存的供应商（返回里的 urls 覆盖清单里的同名协议） */
export function parseTokenResponse(raw: unknown, m: LinkManifest): LinkResult<LinkProvider> {
  if (!isObj(raw)) return fail('bad_token');
  const key = cleanKey(raw.api_key ?? raw.key ?? raw.access_token);
  if (!key) return fail('bad_token');
  const extra = cleanUrls(raw.urls, true);
  if (!extra) return fail('bad_token');
  const urls = { ...m.urls, ...extra };
  if (!Object.keys(urls).length) return fail('bad_token');
  const models = raw.models !== undefined ? cleanModels(raw.models) : m.models;
  return ok({
    name: cleanName(raw.name) || m.name,
    ...(m.homepage ? { homepage: m.homepage } : {}),
    urls,
    key,
    models,
  });
}

/** 与 encodeURIComponent 相同的转义（Go 版照抄这张表，两边拼出同一个串） */
const enc = (s: string) => encodeURIComponent(s);

export function authorizeUrl(m: LinkManifest, state: string, challenge: string): string {
  const q = [
    ['response_type', 'code'],
    ['client_id', CLIENT_ID],
    ['redirect_uri', REDIRECT_URI],
    ['state', state],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
  ]
    .map(([k, v]) => `${k}=${enc(v!)}`)
    .join('&');
  return `${m.authorizationEndpoint}${m.authorizationEndpoint.includes('?') ? '&' : '?'}${q}`;
}

export function tokenRequestBody(code: string, verifier: string): string {
  return [
    ['grant_type', 'authorization_code'],
    ['code', code],
    ['redirect_uri', REDIRECT_URI],
    ['client_id', CLIENT_ID],
    ['code_verifier', verifier],
  ]
    .map(([k, v]) => `${k}=${enc(v!)}`)
    .join('&');
}

const b64url = (b: Buffer) => b.toString('base64url');

export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

export function newPkce(): { state: string; verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { state: b64url(randomBytes(16)), verifier, challenge: pkceChallenge(verifier) };
}

/** 确认框里显示的 Key：前 3 位 + … + 后 4 位（太短只留后 2 位） */
export function maskKey(key: string): string {
  return key.length >= 12 ? `${key.slice(0, 3)}…${key.slice(-4)}` : `…${key.slice(-2)}`;
}

/** 判断两个地址是否同一个（忽略大小写的主机、末尾的 /） */
export function sameUrl(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s.trim());
      return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    } catch {
      return s.trim().replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}
