/**
 * 第三方供应商链接（docs/design/provider-link.md）。
 * 纯逻辑跑 tests/fixtures/provider-link-cases.json（Go 版 internal/core/providerlink 跑同一份）；
 * 改了规则后用 `UPDATE_PROVIDER_LINK_CASES=1 pnpm exec jest providerLink` 重写期望，再核对差异。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderStoreData, SecretCipher } from '@nomi-ai/ai-runtime';

import { GatewayProcess } from '../../../src/gateway/GatewayProcess';
import { GatewayService } from '../../../src/gateway/GatewayService';
import {
  authorizeUrl,
  maskKey,
  parseManifest,
  parseProviderLink,
  parseTokenResponse,
  pkceChallenge,
  sameUrl,
  tokenRequestBody,
  type LinkManifest,
} from '../../../src/gateway/providerLink';
import {
  ProviderLinkService,
  type ProviderLinkOffer,
} from '../../../src/gateway/ProviderLinkService';

const CASES = path.join(__dirname, '../../fixtures/provider-link-cases.json');
const update = process.env.UPDATE_PROVIDER_LINK_CASES === '1';

interface Cases {
  links: Array<{ name: string; url: string; expect?: unknown }>;
  manifests: Array<{ name: string; issuer: string; manifest: unknown; expect?: unknown }>;
  tokens: Array<{
    name: string;
    issuer: string;
    manifest: unknown;
    token: unknown;
    expect?: unknown;
  }>;
  authorize: Array<{ endpoint: string; state: string; challenge: string; expect?: unknown }>;
  pkce: Array<{ verifier: string; expect?: unknown }>;
  body: Array<{ code: string; verifier: string; expect?: unknown }>;
  mask: Array<{ key: string; expect?: unknown }>;
  sameUrl: Array<{ a: string; b: string; expect?: unknown }>;
}

const cases = JSON.parse(fs.readFileSync(CASES, 'utf8')) as Cases;
/** 期望值统一走一遍 JSON（undefined 字段去掉），与 Go 的输出可比 */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

function check(row: { expect?: unknown }, actual: unknown) {
  if (update) row.expect = plain(actual);
  else expect(plain(actual)).toEqual(row.expect);
}

const manifestOf = (issuer: string, raw: unknown): LinkManifest => {
  const m = parseManifest(raw, issuer);
  if (!m.ok) throw new Error(`fixture manifest invalid: ${m.code}`);
  return m.value;
};

describe('providerLink cases (shared with Go)', () => {
  afterAll(() => {
    if (update) fs.writeFileSync(CASES, `${JSON.stringify(cases, null, 2)}\n`);
  });

  it.each(cases.links.map((c) => [c.name, c] as const))('link: %s', (_n, c) =>
    check(c, parseProviderLink(c.url)),
  );
  it.each(cases.manifests.map((c) => [c.name, c] as const))('manifest: %s', (_n, c) =>
    check(c, parseManifest(c.manifest, c.issuer)),
  );
  it.each(cases.tokens.map((c) => [c.name, c] as const))('token: %s', (_n, c) =>
    check(c, parseTokenResponse(c.token, manifestOf(c.issuer, c.manifest))),
  );
  it('authorize / pkce / body / mask / sameUrl', () => {
    for (const c of cases.authorize)
      check(
        c,
        authorizeUrl(
          {
            issuer: 'https://example.com',
            name: 'x',
            urls: {},
            models: [],
            authorizationEndpoint: c.endpoint,
            tokenEndpoint: c.endpoint,
          },
          c.state,
          c.challenge,
        ),
      );
    for (const c of cases.pkce) check(c, pkceChallenge(c.verifier));
    for (const c of cases.body) check(c, tokenRequestBody(c.code, c.verifier));
    for (const c of cases.mask) check(c, maskKey(c.key));
    for (const c of cases.sameUrl) check(c, sameUrl(c.a, c.b));
  });

  it('RFC 7636 appendix B challenge', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

const cipher: SecretCipher = {
  kind: 'none',
  encrypt: (s) => Buffer.from(s, 'utf8').toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'),
};

function gateway() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-link-'));
  const proc = new GatewayProcess({
    logger: { info() {}, warn() {} },
    fork: () => ({ postMessage() {}, kill: () => true, on() {}, once() {} }) as never,
    lazy: true,
  });
  const svc = new GatewayService({
    root: path.join(root, 'gateway'),
    cipher,
    logger: { info() {}, warn() {} },
    process: proc,
    legacy: {
      nomiFile: path.join(root, 'none.json'),
      cliRoot: path.join(root, 'cli'),
      cliDecrypt: (e) => e,
      normalizeNomi: (raw) => raw as unknown as ProviderStoreData,
      token: () => 't',
      routeListening: () => false,
    },
    broadcast: () => undefined,
  });
  svc.init();
  return svc;
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const importUrl = (o: unknown) => `nomi://provider/import?v=1&data=${b64url(o)}`;

function service(
  over: {
    fetch?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const gw = gateway();
  const published: ProviderLinkOffer[][] = [];
  const opened: string[] = [];
  const svc = new ProviderLinkService({
    gateway: () => gw,
    openExternal: async (u) => {
      opened.push(u);
    },
    publish: (o) => published.push(o),
    assertPublic: async () => undefined,
    ...over,
  });
  return { gw, svc, published, opened };
}

describe('ProviderLinkService', () => {
  const payload = {
    name: 'Example AI',
    urls: { chat: 'https://api.example.com/v1' },
    key: 'sk-abcdefghijklmnop',
    models: ['gpt-5'],
  };

  it('A：导入链接 → 待确认（Key 打码）→ 确认后写进网关；再来一次同地址的是更新', async () => {
    const t = service();
    await t.svc.receive(importUrl(payload));
    const [offer] = t.svc.list();
    expect(offer).toMatchObject({
      stage: 'save',
      source: 'link',
      name: 'Example AI',
      keyMasked: 'sk-…mnop',
    });
    expect(JSON.stringify(t.published)).not.toContain('sk-abcdefghijklmnop');
    const r = await t.svc.accept(offer!.id);
    expect(r).toMatchObject({ stage: 'save', name: 'Example AI', updated: false });
    expect(t.svc.list()).toEqual([]);
    const p = t.gw.state().providers.find((x) => x.id === r.providerId)!;
    expect(p.urls.chat).toBe('https://api.example.com/v1');
    expect(p.keys).toHaveLength(1);
    expect(p.models.map((m) => m.id)).toEqual(['gpt-5']);

    // 同地址（末尾多一个 /）+ 新 Key + 新协议地址 + 新模型：更新已有的那个
    await t.svc.receive(
      importUrl({
        ...payload,
        name: 'Other name',
        urls: { chat: 'https://api.example.com/v1/', messages: 'https://api.example.com' },
        key: 'sk-zzzzzzzzzzzzzzzz',
        models: ['gpt-5', 'claude'],
      }),
    );
    const [again] = t.svc.list();
    expect(again!.existing).toEqual({ id: p.id, name: 'Example AI' });
    const r2 = await t.svc.accept(again!.id);
    expect(r2).toMatchObject({ providerId: p.id, updated: true });
    const p2 = t.gw.state().providers.find((x) => x.id === p.id)!;
    expect(p2.name).toBe('Example AI');
    expect(p2.urls).toMatchObject({
      chat: 'https://api.example.com/v1',
      messages: 'https://api.example.com',
    });
    expect(p2.keys).toHaveLength(2);
    expect(p2.models.map((m) => m.id)).toEqual(['gpt-5', 'claude']);

    // 同样的 Key 再来一次：不重复加
    await t.svc.receive(importUrl({ ...payload, key: 'sk-zzzzzzzzzzzzzzzz' }));
    await t.svc.accept(t.svc.list()[0]!.id);
    expect(t.gw.state().providers.find((x) => x.id === p.id)!.keys).toHaveLength(2);
    expect(t.gw.state().providers.filter((x) => x.source !== 'env')).toHaveLength(1);
  });

  it('坏链接 → error 条目（带错误码），拒绝后消失；同样的内容只留一条；最多 5 条；10 分钟过期', async () => {
    let now = 1_000;
    const t = service({ now: () => now });
    await t.svc.receive('nomi://provider/import?v=1&data=%%%');
    expect(t.svc.list()).toMatchObject([{ stage: 'error', error: 'bad_payload' }]);
    t.svc.reject(t.svc.list()[0]!.id);
    expect(t.svc.list()).toEqual([]);

    await t.svc.receive(importUrl(payload));
    await t.svc.receive(importUrl(payload));
    expect(t.svc.list()).toHaveLength(1);
    for (let i = 0; i < 6; i++) await t.svc.receive(importUrl({ ...payload, name: `P${i}` }));
    expect(t.svc.list()).toHaveLength(5);
    now += 10 * 60_000 + 1;
    expect(t.svc.list()).toEqual([]);
    // 不是 provider 的链接不管
    await t.svc.receive('nomi://chat/open');
    expect(t.svc.list()).toEqual([]);
  });

  it('B：connect → 读清单 → 确认后打开浏览器（PKCE）→ 回调换 Key → 确认保存', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://example.com/.well-known/nomi-provider.json')
        return new Response(
          JSON.stringify({
            version: 1,
            name: 'Example AI',
            urls: { messages: 'https://api.example.com' },
            authorization_endpoint: 'https://example.com/nomi/authorize',
            token_endpoint: 'https://api.example.com/nomi/token',
          }),
        );
      if (url === 'https://api.example.com/nomi/token')
        return new Response(JSON.stringify({ api_key: 'sk-fromtoken12345' }));
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const t = service({ fetch: fakeFetch });
    await t.svc.receive('nomi://provider/connect?v=1&issuer=https://example.com');
    const [auth] = t.svc.list();
    expect(auth).toMatchObject({
      stage: 'authorize',
      source: 'issuer',
      issuer: 'https://example.com',
    });
    expect(t.opened).toEqual([]); // 确认之前不打开浏览器
    await t.svc.accept(auth!.id);
    expect(t.opened).toHaveLength(1);
    const u = new URL(t.opened[0]!);
    expect(u.origin + u.pathname).toBe('https://example.com/nomi/authorize');
    expect(u.searchParams.get('redirect_uri')).toBe('nomi://provider/callback');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    const state = u.searchParams.get('state')!;
    const challenge = u.searchParams.get('code_challenge')!;

    await t.svc.receive(`nomi://provider/callback?code=the-code&state=${state}`);
    const tokenCall = calls.find((c) => c.url.endsWith('/nomi/token'))!;
    const body = new URLSearchParams(String(tokenCall.init!.body));
    expect(body.get('code')).toBe('the-code');
    expect(pkceChallenge(body.get('code_verifier')!)).toBe(challenge);
    expect(tokenCall.init!.redirect).toBe('error');

    const [save] = t.svc.list();
    expect(save).toMatchObject({ stage: 'save', source: 'issuer', keyMasked: 'sk-…2345' });
    const r = await t.svc.accept(save!.id);
    expect(t.gw.state().providers.find((x) => x.id === r.providerId)!.urls.messages).toBe(
      'https://api.example.com',
    );

    // state 只能用一次
    await t.svc.receive(`nomi://provider/callback?code=the-code&state=${state}`);
    expect(t.svc.list()).toMatchObject([{ stage: 'error', error: 'bad_state' }]);
  });

  it('B：用户在网页上拒绝 → denied；清单拿不到 → network / bad_manifest', async () => {
    let manifestStatus = 200;
    const fakeFetch = (async () =>
      manifestStatus === 0
        ? Promise.reject(new Error('offline'))
        : new Response(
            JSON.stringify({
              authorization_endpoint: 'https://example.com/a',
              token_endpoint: 'https://example.com/t',
            }),
            { status: manifestStatus },
          )) as unknown as typeof fetch;
    const t = service({ fetch: fakeFetch });
    await t.svc.connect('example.com');
    const state = new URL(t.opened[0]!).searchParams.get('state')!;
    await t.svc.receive(`nomi://provider/callback?error=access_denied&state=${state}`);
    expect(t.svc.list()).toMatchObject([{ stage: 'error', error: 'denied' }]);

    manifestStatus = 0;
    await t.svc.receive('nomi://provider/connect?issuer=https://down.example.com');
    expect(t.svc.list().at(-1)).toMatchObject({ error: 'network' });
    manifestStatus = 500;
    await t.svc.receive('nomi://provider/connect?issuer=https://broken.example.com');
    expect(t.svc.list().at(-1)).toMatchObject({ error: 'bad_manifest' });
    await expect(t.svc.connect('http://example.com')).rejects.toMatchObject({ code: 'bad_issuer' });
  });
});
