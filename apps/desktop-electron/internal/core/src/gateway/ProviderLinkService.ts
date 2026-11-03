/**
 * 第三方供应商链接（docs/design/provider-link.md）的流程：宿主把收到的 `nomi://provider/*` 交给 receive()，
 * 这里解析、（B 档）读授权清单 / 换 Key，产出「待确认」交给视图；用户确认后才写进网关。
 * 链接里有 Key：日志只记类型，不记原文；视图只拿到打码后的 Key。
 */
import type { GatewayService } from './GatewayService';
import {
  authorizeUrl,
  maskKey,
  newPkce,
  normalizeIssuer,
  parseManifest,
  parseProviderLink,
  parseTokenResponse,
  tokenRequestBody,
  type LinkErrorCode,
  type LinkManifest,
  type LinkProvider,
  type LinkWire,
} from './providerLink';

export const OFFER_TTL_MS = 10 * 60_000;
export const MAX_OFFERS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY = 64 * 1024;

/** 视图看到的一条待确认 */
export interface ProviderLinkOffer {
  id: string;
  /** authorize = 去第三方供应商的网页授权；save = 保存；error = 链接无法处理（只显示原因） */
  stage: 'authorize' | 'save' | 'error';
  /** link = 链接直接带来（来源网站无法验证）；issuer = 经授权清单（来源是 issuer 域名） */
  source: 'link' | 'issuer';
  issuer?: string;
  name: string;
  homepage?: string;
  urls: Partial<Record<LinkWire, string>>;
  keyMasked?: string;
  models: string[];
  /** 已有同地址的第三方供应商：确认后更新它 */
  existing?: { id: string; name: string };
  error?: LinkErrorCode;
  createdAt: number;
  expiresAt: number;
}

export interface ProviderLinkAcceptResult {
  stage: ProviderLinkOffer['stage'];
  providerId?: string;
  name?: string;
  updated?: boolean;
}

interface Offer {
  view: ProviderLinkOffer;
  provider?: LinkProvider;
  manifest?: LinkManifest;
  /** 去重用：同样的内容只留一条 */
  sig: string;
}

interface Session {
  verifier: string;
  manifest: LinkManifest;
  expiresAt: number;
}

export interface ProviderLinkLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ProviderLinkDeps {
  gateway: () => GatewayService | null | undefined;
  openExternal: (url: string) => Promise<void>;
  /** 待确认列表变了（契约事件 providerLink.changed） */
  publish: (offers: ProviderLinkOffer[]) => void;
  /** 有新的待确认：把对话窗口带到前台 */
  reveal?: () => void;
  /** 出站前校验：主机解析出的地址都是公网（netGuard） */
  assertPublic: (url: string) => Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
  logger?: ProviderLinkLogger;
}

export class ProviderLinkError extends Error {
  constructor(readonly code: LinkErrorCode | 'not_found' | 'unavailable') {
    super(code);
  }
}

let seq = 0;

export class ProviderLinkService {
  private offers: Offer[] = [];
  private sessions = new Map<string, Session>();

  constructor(private readonly d: ProviderLinkDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private purge(): boolean {
    const now = this.now();
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k);
    const before = this.offers.length;
    this.offers = this.offers.filter((o) => o.view.expiresAt > now);
    return before !== this.offers.length;
  }

  list(): ProviderLinkOffer[] {
    if (this.purge()) this.emit();
    return this.offers.map((o) => o.view);
  }

  private emit(): void {
    this.d.publish(this.offers.map((o) => o.view));
  }

  private add(
    o: Omit<Offer, 'view'> & { view: Omit<ProviderLinkOffer, 'id' | 'createdAt' | 'expiresAt'> },
  ) {
    this.purge();
    const now = this.now();
    this.offers = this.offers.filter((x) => x.sig !== o.sig);
    this.offers.push({
      ...o,
      view: {
        ...o.view,
        id: `pl_${now.toString(36)}_${(seq++).toString(36)}`,
        createdAt: now,
        expiresAt: now + OFFER_TTL_MS,
      },
    });
    while (this.offers.length > MAX_OFFERS) this.offers.shift();
    this.emit();
    this.d.reveal?.();
  }

  private addError(code: LinkErrorCode, issuer?: string): void {
    this.d.logger?.warn('第三方供应商链接无法处理', { code });
    this.add({
      sig: `error:${code}:${issuer ?? ''}`,
      view: {
        stage: 'error',
        source: issuer ? 'issuer' : 'link',
        ...(issuer ? { issuer } : {}),
        name: issuer ? new URL(issuer).hostname : '',
        urls: {},
        models: [],
        error: code,
      },
    });
  }

  private saveOffer(p: LinkProvider, source: 'link' | 'issuer', issuer?: string): void {
    const existing = this.d.gateway()?.findProviderByUrls(Object.values(p.urls)) ?? undefined;
    this.add({
      provider: p,
      sig: `save:${JSON.stringify([p.name, p.urls, p.key, p.models])}`,
      view: {
        stage: 'save',
        source,
        ...(issuer ? { issuer } : {}),
        name: p.name,
        ...(p.homepage ? { homepage: p.homepage } : {}),
        urls: p.urls,
        keyMasked: maskKey(p.key),
        models: p.models,
        ...(existing ? { existing } : {}),
      },
    });
  }

  /** 宿主收到的 `nomi://` 链接（不是 provider 的忽略） */
  async receive(url: string): Promise<void> {
    if (!/^nomi:\/\/provider\b/i.test(url.trim())) return;
    const parsed = parseProviderLink(url);
    if (!parsed.ok) return this.addError(parsed.code);
    const link = parsed.value;
    this.d.logger?.info('收到第三方供应商链接', { kind: link.kind });
    if (link.kind === 'import') return this.saveOffer(link.provider, 'link');
    if (link.kind === 'connect') {
      try {
        const m = await this.manifest(link.issuer);
        this.add({
          manifest: m,
          sig: `authorize:${m.issuer}`,
          view: {
            stage: 'authorize',
            source: 'issuer',
            issuer: m.issuer,
            name: m.name,
            ...(m.homepage ? { homepage: m.homepage } : {}),
            urls: m.urls,
            models: m.models,
          },
        });
      } catch (e) {
        this.addError(codeOf(e), link.issuer);
      }
      return;
    }
    // callback
    this.purge();
    const s = this.sessions.get(link.state);
    this.sessions.delete(link.state);
    if (!s) return this.addError('bad_state');
    if (!link.code) return this.addError('denied', s.manifest.issuer);
    try {
      const raw = await this.postForm(
        s.manifest.tokenEndpoint,
        tokenRequestBody(link.code, s.verifier),
      );
      const p = parseTokenResponse(raw, s.manifest);
      if (!p.ok) return this.addError(p.code, s.manifest.issuer);
      this.saveOffer(p.value, 'issuer', s.manifest.issuer);
    } catch (e) {
      this.addError(codeOf(e), s.manifest.issuer);
    }
  }

  /** 设置里填域名发起授权（用户自己发起，不再多确认一次）：读清单、打开浏览器 */
  async connect(issuerRaw: string): Promise<{ name: string; issuer: string }> {
    const issuer = normalizeIssuer(
      /^https:\/\//i.test(issuerRaw.trim()) ? issuerRaw.trim() : `https://${issuerRaw.trim()}`,
    );
    if (!issuer) throw new ProviderLinkError('bad_issuer');
    const m = await this.manifest(issuer);
    await this.authorize(m);
    return { name: m.name, issuer: m.issuer };
  }

  async accept(id: string): Promise<ProviderLinkAcceptResult> {
    this.purge();
    const o = this.offers.find((x) => x.view.id === id);
    if (!o) throw new ProviderLinkError('not_found');
    if (o.view.stage === 'authorize' && o.manifest) {
      await this.authorize(o.manifest);
      this.remove(id);
      return { stage: 'authorize', name: o.view.name };
    }
    if (o.view.stage === 'save' && o.provider) {
      const gw = this.d.gateway();
      if (!gw) throw new ProviderLinkError('unavailable');
      const r = gw.importLinkedProvider(o.provider);
      this.remove(id);
      this.d.logger?.info('已从链接保存第三方供应商', { updated: r.updated });
      return {
        stage: 'save',
        providerId: r.provider.id,
        name: r.provider.name,
        updated: r.updated,
      };
    }
    this.remove(id);
    return { stage: o.view.stage };
  }

  reject(id: string): void {
    this.remove(id);
  }

  private remove(id: string): void {
    const before = this.offers.length;
    this.offers = this.offers.filter((x) => x.view.id !== id);
    if (before !== this.offers.length) this.emit();
  }

  private async authorize(m: LinkManifest): Promise<void> {
    const { state, verifier, challenge } = newPkce();
    this.purge();
    // 未完成的授权最多留 5 个
    while (this.sessions.size >= MAX_OFFERS)
      this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(state, { verifier, manifest: m, expiresAt: this.now() + OFFER_TTL_MS });
    await this.d.openExternal(authorizeUrl(m, state, challenge));
  }

  private async manifest(issuer: string): Promise<LinkManifest> {
    const raw = await this.getJson(`${issuer}/.well-known/nomi-provider.json`);
    const m = parseManifest(raw, issuer);
    if (!m.ok) throw new ProviderLinkError(m.code);
    return m.value;
  }

  private async getJson(url: string): Promise<unknown> {
    return this.request(
      url,
      { method: 'GET', headers: { accept: 'application/json' } },
      'bad_manifest',
    );
  }

  private async postForm(url: string, body: string): Promise<unknown> {
    return this.request(
      url,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      },
      'bad_token',
    );
  }

  private async request(url: string, init: RequestInit, bad: LinkErrorCode): Promise<unknown> {
    try {
      await this.d.assertPublic(url);
    } catch {
      throw new ProviderLinkError(bad === 'bad_manifest' ? 'bad_issuer' : bad);
    }
    const f = this.d.fetch ?? fetch;
    let res: Response;
    try {
      // 不跟随跳转：跳转目标可能指向内网，也可能换了主机
      res = await f(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new ProviderLinkError('network');
    }
    if (!res.ok) throw new ProviderLinkError(bad);
    const text = await res.text();
    if (text.length > MAX_BODY) throw new ProviderLinkError(bad);
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderLinkError(bad);
    }
  }
}

function codeOf(e: unknown): LinkErrorCode {
  return e instanceof ProviderLinkError && e.code !== 'not_found' && e.code !== 'unavailable'
    ? e.code
    : 'network';
}
