/**
 * 密钥不出本机（docs/design/secret-privacy.md）：发往云端第三方供应商之前把密钥换成占位符，回程换回来。
 * 对所有客户端一视同仁，唯一的区分是上游在不在本机。
 */
import type { GatewayConfig, PrivacyConfig } from '../config';
import { isPrivateHost } from '../net/address';
import { isLoopbackHost } from '../net/loopback';
import type { Candidate } from '../route/resolve';

import { maskBody, maskText, type MaskResult, type RedactionHit } from './mask';
import { SecretStore } from './store';

export { isIdKey, maskBody, maskText } from './mask';
export type { MaskOptions, MaskResult, PrivacyAction, RedactionHit } from './mask';
export {
  allowTagOf,
  MAX_PLACEHOLDER_LEN,
  PLACEHOLDER_RE,
  placeholderOf,
  tagOf,
} from './placeholder';
export { Restorer } from './restore';
export { shapeOf } from './shape';
export {
  entropy,
  hasSecret,
  mergeSpans,
  PRIVACY_KINDS,
  ruleSpans,
  RULES_VERSION,
  type RuleOptions,
  type SecretKind,
  type SecretSpan,
} from './rules';
export { MAX_VALUES, MIN_KNOWN, SecretStore } from './store';

/** 候选的上游在本机 / 局域网（Ollama、LM Studio…）：数据不出本机，默认不脱敏 */
export function isLocalCandidate(c: Candidate): boolean {
  const url = c.provider.urls[c.wire];
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return isLoopbackHost(host) || isPrivateHost(host);
  } catch {
    return false;
  }
}

/** 快照里已知的密钥原文：第三方 Key、客户端令牌、主进程登记的其他密钥 */
export function knownSecrets(cfg: GatewayConfig): Array<{ kind: string; value: string }> {
  const out: Array<{ kind: string; value: string }> = [];
  for (const p of cfg.providers)
    for (const k of p.keys) out.push({ kind: 'API_KEY', value: k.value });
  for (const c of Object.values(cfg.clients)) if (c) out.push({ kind: 'TOKEN', value: c.token });
  if (cfg.legacyToken) out.push({ kind: 'TOKEN', value: cfg.legacyToken });
  for (const k of cfg.privacy?.known ?? []) out.push(k);
  return out.filter((k) => Boolean(k.value));
}

/**
 * 「试一试」（§12）：一段文字按这份设置会变成什么、找到了哪些值。用一次性的存储，
 * 不登记已见值，也不影响网关进程里的占位符；主进程直接调用，不经网关进程。
 */
export function previewPrivacy(
  text: string,
  p: Pick<PrivacyConfig, 'key' | 'strict' | 'shape' | 'actions' | 'allow' | 'known'>,
): { text: string; hits: RedactionHit[] } {
  const store = new SecretStore();
  store.setKey(p.key);
  store.setShape(p.shape === true);
  store.setKnown(p.known ?? []);
  const r = maskText(text, store, {
    key: p.key,
    ...(p.strict ? { strict: true } : {}),
    ...(p.actions ? { actions: p.actions } : {}),
    ...(p.allow?.length ? { allow: new Set(p.allow) } : {}),
  });
  return { text: r.text, hits: r.hits };
}

/** 网关进程里的隐私模式：已见值跨请求、跨客户端共享，随配置快照更新 */
export class GatewayPrivacy {
  readonly store = new SecretStore();

  /** 换快照时调用 */
  configure(cfg: GatewayConfig): void {
    const p = cfg.privacy;
    if (!p?.enabled) {
      this.store.clear();
      return;
    }
    this.store.setKey(p.key);
    this.store.setShape(p.shape === true);
    this.store.setKnown(knownSecrets(cfg));
  }

  /** 这个候选要不要发脱敏后的请求体 */
  applies(cfg: GatewayConfig, c: Candidate): boolean {
    return Boolean(cfg.privacy?.enabled) && (cfg.privacy?.local === true || !isLocalCandidate(c));
  }

  mask(cfg: GatewayConfig, body: unknown): MaskResult {
    const p = cfg.privacy!;
    return maskBody(body, this.store, {
      key: p.key,
      ...(p.strict ? { strict: true } : {}),
      ...(p.actions ? { actions: p.actions } : {}),
      ...(p.allow?.length ? { allow: new Set(p.allow) } : {}),
    });
  }
}
