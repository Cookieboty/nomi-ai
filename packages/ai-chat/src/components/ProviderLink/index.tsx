/**
 * 第三方供应商链接的确认框（docs/design/provider-link.md）：网页上的 `nomi://provider/*` 链接经内核解析后，
 * 在这里请用户确认。一次只显示最早的一条；确认保存后打开「设置 → 模型与供应商」看结果。
 * - save：名称、来源、各协议地址、打码后的 Key、模型数；已有同地址的显示「更新」；
 * - authorize：去第三方供应商的网页授权（打开系统浏览器）；
 * - error：链接无法处理的原因。
 */
import { Button, Modal, t, useLocale } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { gatewayClient, WIRE_LABEL, WIRES } from '../../services/gatewayClient';
import { defaultEnabled, modelRows, storedProbes } from '../ModelsPage/providerSetup';
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
          {busy
            ? t('ui.provider-link.working')
            : offer.stage === 'authorize'
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
            {/* 只写能核实的来源：授权连接写 issuer 域名（Nomi 自己连过它）；链接导入只说无法确认，
                不显示链接自带的网站名 / 主页，免得被伪造的域名误导 */}
            <dd>
              {offer.source === 'issuer' ? (
                hostOf(offer.issuer)
              ) : (
                <span className={styles.warn} data-testid="provider-link-unverified">
                  {t('ui.provider-link.source-link')}
                </span>
              )}
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
              {[
                offer.source === 'link' ? t('ui.provider-link.unverified-hint') : '',
                offer.existing
                  ? t('ui.provider-link.update-hint')
                  : t('ui.provider-link.trust-hint'),
              ]
                .filter(Boolean)
                .join(' ')}
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

/**
 * 链接导入后供应商还没有模型：检测一次（用刚存下的 Key），按添加时的规则启用对话模型。
 * 失败不打扰（用户可以在模型页手动检测）。
 */
export async function fillLinkedModels(providerId: string): Promise<void> {
  try {
    const state = await gatewayClient.state();
    const p = state.providers.find((x) => x.id === providerId);
    if (!p || p.models.length) return;
    const r = await gatewayClient.detect({ providerId });
    const rows = modelRows(r, null);
    if (!rows.length) return;
    const enabled = defaultEnabled(rows);
    await gatewayClient.upsertProvider({
      id: p.id,
      name: p.name,
      urls: {},
      models: rows.map((m) => ({
        id: m.id,
        enabled: enabled.has(m.id),
        ...(m.chat ? {} : { toolCalling: false }),
        ...(r.limits?.[m.id] ? { ...r.limits[m.id], metaSource: 'listed' as const } : {}),
      })),
      detected: storedProbes(r),
    });
  } catch {
    /* 检测失败：模型页里可以手动检测 */
  }
}

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
        if (r.stage !== 'save') return;
        // 链接没带模型：后台拉一次模型列表（与添加时的检测相同），不让新加的供应商显示 0 个模型
        if (r.providerId) void fillLinkedModels(r.providerId);
        // 保存好了：打开「设置 → 模型与供应商」看刚加的第三方供应商
        window.dispatchEvent(new CustomEvent(OPEN_MODELS_EVENT));
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
