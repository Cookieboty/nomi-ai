/**
 * 第三方供应商链接（docs/design/provider-link.md）的视图侧：待确认列表、确认 / 拒绝、在设置里发起授权。
 * 内核在应用没开时收到链接会先存着：窗口挂载后拉一次列表，之后靠 `providerLink.changed`。
 */
import { isContractError } from '@nomi-ai/contract';
import { t } from '@nomi-ai/ui';

import { api, hasTransport, type AppClient } from '../../services/api';

export type ProviderLinkOffer = Awaited<ReturnType<AppClient['providerLink']['list']>>[number];
export type ProviderLinkAcceptResult = Awaited<ReturnType<AppClient['providerLink']['accept']>>;

const noop = () => undefined;

export const providerLinkClient = {
  /** 订阅待确认列表（含窗口挂载前就到的）；返回退订 */
  subscribe(fn: (offers: ProviderLinkOffer[]) => void): () => void {
    if (!hasTransport()) return noop;
    let alive = true;
    const off = api.on('providerLink.changed', (p) => fn(p as ProviderLinkOffer[]));
    void api.providerLink
      .list()
      .then((o) => alive && fn(o))
      .catch(noop);
    return () => {
      alive = false;
      off();
    };
  },
  accept: (id: string) => api.providerLink.accept({ id }),
  reject: (id: string) => api.providerLink.reject({ id }),
  connect: (issuer: string) => api.providerLink.connect({ issuer }),
};

const ERRORS: Record<string, string> = {
  bad_link: 'ui.provider-link.err-bad-link',
  too_long: 'ui.provider-link.err-too-long',
  bad_payload: 'ui.provider-link.err-bad-payload',
  bad_name: 'ui.provider-link.err-bad-name',
  bad_url: 'ui.provider-link.err-bad-url',
  bad_key: 'ui.provider-link.err-bad-key',
  bad_issuer: 'ui.provider-link.err-bad-issuer',
  bad_manifest: 'ui.provider-link.err-bad-manifest',
  bad_token: 'ui.provider-link.err-bad-token',
  bad_state: 'ui.provider-link.err-bad-state',
  denied: 'ui.provider-link.err-denied',
  network: 'ui.provider-link.err-network',
};

/** 错误码（条目里的 error，或契约错误 PROVIDER_LINK_FAILED 的 message）→ 界面文案 */
export function linkErrorText(code: string | undefined): string {
  return t((code && ERRORS[code]) || 'ui.provider-link.err-network');
}

/** 契约调用抛的错 → 界面文案（不是链接错误时用原始信息） */
export function linkCallErrorText(err: unknown): string {
  if (isContractError(err) && err.code === 'PROVIDER_LINK_FAILED')
    return linkErrorText(err.message);
  return err instanceof Error ? err.message : String(err);
}
