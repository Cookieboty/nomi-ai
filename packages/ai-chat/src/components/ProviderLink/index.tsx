/**
 * 第三方供应商链接的确认框（docs/design/provider-link.md）：网页上的 `nomi://provider/*` 链接经内核解析后，
 * 在这里请用户确认。一次只显示最早的一条；确认保存后打开「设置 → 模型与供应商」看结果。
 * - save：名称、来源、各协议地址、打码后的 Key、模型数；已有同地址的显示「更新」；
 * - authorize：去第三方供应商的网页授权（打开系统浏览器）；
 * - error：链接无法处理的原因。
 */
import { Button, Modal, t, useLocale } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { WIRE_LABEL, WIRES } from '../../services/gatewayClient';
import { OPEN_MODELS_EVENT } from '../Onboarding/client';

import {
  linkCallErrorText,
  linkErrorText,
  providerLinkClient,
  type ProviderLinkOffer,
} from './client';
import styles from './index.module.css';

const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).host : '';
  } catch {
    return u ?? '';
  }
};

export const ProviderLinkDialog: React.FC<{
  offer: ProviderLinkOffer;
  busy: boolean;
  error: string | null;
  onAccept: () => void;
  onReject: () => void;
}> = ({ offer, busy, error, onAccept, onReject }) => {
  useLocale();
  const title =
    offer.stage === 'error'
      ? t('ui.provider-link.error-title')
      : offer.stage === 'authorize'
        ? t('ui.provider-link.authorize-title')
        : offer.existing
          ? t('ui.provider-link.update-title', offer.existing.name)
          : t('ui.models.add-third-party-provider');
  const footer =
    offer.stage === 'error' ? (
      <Button variant="primary" onClick={onReject} data-testid="provider-link-ok">
        {t('ui.models.got-it')}
      </Button>
    ) : (
      <>
        <Button onClick={onReject} disabled={busy} data-testid="provider-link-reject">
          {t('ui.foundation.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={onAccept}
          disabled={busy}
          data-testid="provider-link-accept"
        >
          {offer.stage === 'authorize'
            ? t('ui.provider-link.go-authorize')
            : offer.existing
              ? t('ui.provider-link.update')
              : t('ui.foundation.add')}
        </Button>
      </>
    );
  const wires = WIRES.filter((w) => offer.urls[w]);
  return (
    <Modal open onClose={onReject} title={title} footer={footer} data-testid="provider-link-dialog">
      {offer.stage === 'error' ? (
        <p className={styles.text} data-testid="provider-link-error">
          {linkErrorText(offer.error)}
        </p>
      ) : (
        <div className={styles.stack}>
          {offer.stage === 'authorize' ? (
            <p className={styles.text}>
              {t('ui.provider-link.authorize-hint', hostOf(offer.issuer))}
            </p>
          ) : null}
          <dl className={styles.facts} data-testid="provider-link-facts">
            <dt>{t('ui.foundation.name')}</dt>
            <dd>{offer.name}</dd>
            <dt>{t('ui.provider-link.source')}</dt>
            <dd>
              {offer.source === 'issuer' ? hostOf(offer.issuer) : t('ui.provider-link.source-link')}
              {offer.homepage && hostOf(offer.homepage) !== hostOf(offer.issuer) ? (
                <span className={styles.muted}> · {hostOf(offer.homepage)}</span>
              ) : null}
            </dd>
            {wires.map((w) => (
              <React.Fragment key={w}>
                <dt>{WIRE_LABEL[w]}</dt>
                <dd>
                  <code>{offer.urls[w]}</code>
                </dd>
              </React.Fragment>
            ))}
            {offer.keyMasked ? (
              <>
                <dt>{t('ui.provider-link.key')}</dt>
                <dd>
                  <code data-testid="provider-link-key">{offer.keyMasked}</code>
                </dd>
              </>
            ) : null}
            {offer.models.length ? (
              <>
                <dt>{t('ui.provider-link.models')}</dt>
                <dd title={offer.models.join('\n')}>
                  {t('ui.provider-link.models-count', String(offer.models.length))}
                </dd>
              </>
            ) : null}
          </dl>
          {offer.stage === 'save' ? (
            <p className={styles.hint}>
              {offer.existing
                ? t('ui.provider-link.update-hint')
                : t('ui.provider-link.trust-hint')}
            </p>
          ) : null}
        </div>
      )}
      {error ? (
        <p className={styles.error} role="alert" data-testid="provider-link-fail">
          {error}
        </p>
      ) : null}
    </Modal>
  );
};

/** 挂在对话窗口里：有待确认的链接就弹出 */
export const ProviderLinkHost: React.FC = () => {
  const [offers, setOffers] = useState<ProviderLinkOffer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => providerLinkClient.subscribe(setOffers), []);
  const offer = offers[0];
  if (!offer) return null;
  const accept = () => {
    setBusy(true);
    setError(null);
    providerLinkClient
      .accept(offer.id)
      .then((r) => {
        // 保存好了：打开「设置 → 模型与供应商」看刚加的第三方供应商
        if (r.stage === 'save') window.dispatchEvent(new CustomEvent(OPEN_MODELS_EVENT));
      })
      .catch((e: unknown) => setError({ id: offer.id, text: linkCallErrorText(e) }))
      .finally(() => setBusy(false));
  };
  const reject = () => {
    setError(null);
    void providerLinkClient.reject(offer.id).catch(() => undefined);
    // 先在本地拿掉，不等事件回来
    setOffers((o) => o.filter((x) => x.id !== offer.id));
  };
  return (
    <ProviderLinkDialog
      key={offer.id}
      offer={offer}
      busy={busy}
      error={error?.id === offer.id ? error.text : null}
      onAccept={accept}
      onReject={reject}
    />
  );
};
