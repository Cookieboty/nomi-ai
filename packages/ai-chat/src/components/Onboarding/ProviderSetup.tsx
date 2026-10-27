/**
 * 引导里的「接上模型」：一个连贯的两段式流程，不弹对话框。
 *   1. 选第三方供应商（预设或自定义地址）→ 填 Key / 地址 → 检测并保存（与设置里的模型页同一套存储）；
 *   2. 供应商配好后列出它的对话模型，点一个即设为 Nomi 对话使用的模型。供应商没配好前第 2 段置灰。
 */
import { Icon, t } from '@nomi-ai/ui';
import { CheckCircle2 } from 'lucide-react';
import React, { useState } from 'react';

import { gatewayClient, type GatewayState } from '../../services/gatewayClient';
import { nomiMainRef, refreshNomiModel, useGatewayState } from '../../services/nomiModel';
import { ProviderForm } from '../ModelsPage/ProviderForm';

import styles from './index.module.css';

/** 已配置、可用于对话的供应商（启用且至少有一个启用的对话模型） */
export function usableProviders(s: GatewayState | null) {
  return (s?.providers ?? []).filter(
    (p) => p.enabled && p.models.some((m) => m.enabled && m.toolCalling !== false),
  );
}

export const ProviderSetup: React.FC<{ onOpenModels: () => void }> = ({ onOpenModels }) => {
  const state = useGatewayState();
  const usable = usableProviders(state);
  const current = state ? nomiMainRef(state) : null;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  // 第 2 段列哪个供应商：刚配好的 > 当前 Nomi 用的 > 第一个可用的
  const providerId =
    (picked && usable.some((p) => p.id === picked) ? picked : null) ??
    (current ? current.slice(0, current.indexOf('/')) : null) ??
    usable[0]?.id ??
    null;
  const provider = usable.find((p) => p.id === providerId) ?? null;
  const configured = usable.length > 0 && !editing;

  const assign = (ref: string) => {
    setError(null);
    gatewayClient
      .setAssignment('nomi', { models: { main: ref } })
      .then(refreshNomiModel)
      .catch((e: Error) => setError(e.message));
  };

  const chatModels = provider?.models.filter((m) => m.enabled && m.toolCalling !== false) ?? [];

  return (
    <>
      <section
        className={styles.section}
        data-testid="onb-provider-section"
        data-state={configured ? 'configured' : 'form'}
      >
        <div className={styles.sectionHead}>
          <span className={styles.sectionNo}>1</span>
          <span className={styles.subLabel}>{t('ui.mascot-theme.onb-choose-provider')}</span>
        </div>
        {configured ? (
          <div className={styles.configured}>
            <Icon icon={CheckCircle2} />
            <span className={styles.grow} data-testid="onb-provider-configured">
              {t('ui.mascot-theme.onb-provider-configured', provider?.name ?? usable[0]!.name)}
            </span>
            <button
              type="button"
              className={styles.link}
              data-testid="onb-provider-change"
              onClick={() => setEditing(true)}
            >
              {t('ui.mascot-theme.onb-use-another-provider')}
            </button>
          </div>
        ) : (
          <ProviderForm
            idPrefix="onb"
            onSaved={(p) => {
              setPicked(p.id);
              setEditing(false);
              refreshNomiModel();
            }}
            onCancel={usable.length > 0 ? () => setEditing(false) : undefined}
          />
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </section>

      <section
        className={`${styles.section} ${provider ? '' : styles.sectionOff}`}
        data-testid="onb-model-section"
        aria-disabled={!provider}
        data-state={!provider ? 'disabled' : current ? 'ready' : 'choose'}
      >
        <div className={styles.sectionHead}>
          <span className={styles.sectionNo}>2</span>
          <span className={styles.subLabel}>{t('ui.mascot-theme.onb-choose-model')}</span>
        </div>
        {!provider ? (
          <p className={styles.note}>{t('ui.mascot-theme.onb-provider-first')}</p>
        ) : (
          <div className={styles.chips} role="radiogroup">
            {chatModels.map((m) => {
              const ref = `${provider.id}/${m.id}`;
              return (
                <button
                  key={ref}
                  type="button"
                  role="radio"
                  aria-checked={current === ref}
                  className={`${styles.chip} ${current === ref ? styles.optionOn : ''}`}
                  data-testid={`onb-model-${m.id}`}
                  onClick={() => assign(ref)}
                >
                  {current === ref && <Icon icon={CheckCircle2} size={14} />}
                  <span>{m.label ?? m.id}</span>
                </button>
              );
            })}
          </div>
        )}
        {current && provider && (
          <p className={styles.note} data-testid="onb-model-ready">
            {t('ui.mascot-theme.onb-model-ready')}
          </p>
        )}
      </section>

      <p className={styles.note}>
        <button
          type="button"
          className={styles.link}
          data-testid="onb-open-models"
          onClick={onOpenModels}
        >
          {t('ui.mascot-theme.open-full-model-settings')}
        </button>{' '}
        {t('ui.mascot-theme.open-full-model-settings-hint')}
      </p>
    </>
  );
};
