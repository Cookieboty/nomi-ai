/**
 * 引导里的「接上模型」：一个连贯的两段式流程，不弹对话框。
 *   1. 选第三方供应商（预设或自定义地址）→ 填 Key / 地址 → 检测并保存（与设置里的模型页同一套存储）；
 *   2. 供应商配好后列出它的对话模型，点一个即设为 Nomi 对话使用的模型。供应商没配好前第 2 段置灰。
 */
import { BrandIcon, Icon, t } from '@nomi-ai/ui';
import { CheckCircle2, Globe, Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  gatewayClient,
  hostPortOf,
  isPrivateUrl,
  WIRES,
  type GatewayState,
} from '../../services/gatewayClient';
import { nomiMainRef, refreshNomiModel, useGatewayState } from '../../services/nomiModel';
import {
  providerClient,
  providerClientAvailable,
  type ProviderPreset,
} from '../../services/providerClient';
import {
  defaultEnabled,
  groupOf,
  modelRows,
  presetUrls,
  recommendedOf,
  saveDetectedProvider,
} from '../ModelsPage/AddProviderDialog';

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
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  /** undefined：还没选；null：自定义地址 */
  const [preset, setPreset] = useState<ProviderPreset | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!providerClientAvailable()) return;
    let alive = true;
    providerClient
      .presets()
      .then((ps) => alive && setPresets(ps.filter((p) => p.category !== 'custom')))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 第 2 段列哪个供应商：刚配好的 > 当前 Nomi 用的 > 第一个可用的
  const providerId =
    (picked && usable.some((p) => p.id === picked) ? picked : null) ??
    (current ? current.slice(0, current.indexOf('/')) : null) ??
    usable[0]?.id ??
    null;
  const provider = usable.find((p) => p.id === providerId) ?? null;
  const configured = usable.length > 0 && !editing;
  const ordered = useMemo(
    () =>
      [...presets].sort((a, b) => Number(groupOf(a) === 'local') - Number(groupOf(b) === 'local')),
    [presets],
  );

  const custom = preset === null;
  const needsKey = custom || Boolean(preset?.requiresApiKey);
  const baseUrl = custom ? url.trim() : (preset?.baseURL ?? '');
  const canSave = preset !== undefined && baseUrl.length > 0 && (!needsKey || key.trim()) && !busy;

  const save = async () => {
    if (preset === undefined) return;
    setBusy(true);
    setError(null);
    try {
      if (isPrivateUrl(baseUrl)) {
        const hp = hostPortOf(baseUrl);
        if (hp) {
          if (custom && !window.confirm(t('ui.models.is-a-local-or-lan-address-allow-nomi', hp)))
            return;
          await gatewayClient.confirmPrivateHost(hp);
        }
      }
      const keys = key.trim() ? [key.trim()] : [];
      const result = await gatewayClient.detect({
        ...(preset ? { urls: presetUrls(preset) } : { url: baseUrl }),
        keys,
        fallbackModel: recommendedOf(preset)[0] || undefined,
      });
      if (!WIRES.some((w) => result.wires[w]?.ok)) {
        setError(t('ui.models.no-api-is-available-so-this-can-t'));
        return;
      }
      const rows = modelRows(result, preset);
      if (!rows.some((r) => r.chat)) {
        setError(t('ui.models.no-model-list-was-returned-go-back-and'));
        return;
      }
      const saved = await saveDetectedProvider({
        result,
        preset,
        name: preset?.name ?? '',
        keys,
        models: rows,
        enabled: defaultEnabled(rows),
      });
      setPicked(saved.id);
      setEditing(false);
      setPreset(undefined);
      setKey('');
      setUrl('');
      refreshNomiModel();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
        data-state={configured ? 'configured' : preset !== undefined ? 'form' : 'choose'}
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
          <>
            <div className={styles.chips} role="radiogroup">
              {ordered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={preset?.id === p.id}
                  className={`${styles.chip} ${preset?.id === p.id ? styles.optionOn : ''}`}
                  data-testid={`onb-preset-${p.id}`}
                  onClick={() => {
                    setPreset(p);
                    setError(null);
                  }}
                >
                  <BrandIcon brand={p.icon ?? p.id} name={p.name} size={16} />
                  <span>{p.name}</span>
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={custom}
                className={`${styles.chip} ${custom ? styles.optionOn : ''}`}
                data-testid="onb-preset-custom"
                onClick={() => {
                  setPreset(null);
                  setError(null);
                }}
              >
                <Icon icon={Globe} size={16} />
                <span>{t('ui.models.custom-address')}</span>
              </button>
            </div>
            {preset !== undefined && (
              <div className={styles.form} data-testid="onb-provider-form">
                {custom && (
                  <input
                    className={styles.input}
                    data-testid="onb-provider-url"
                    value={url}
                    placeholder="https://api.example.com/v1"
                    aria-label={t('ui.models.address')}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                )}
                {needsKey ? (
                  <input
                    className={styles.input}
                    type="password"
                    data-testid="onb-provider-key"
                    value={key}
                    placeholder={t('API Key')}
                    aria-label={t('API Key')}
                    autoComplete="off"
                    onChange={(e) => setKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && canSave && void save()}
                  />
                ) : (
                  <p className={styles.note}>{t('ui.models.local-services-don-t-need-a-key')}</p>
                )}
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.primary}
                    data-testid="onb-provider-save"
                    disabled={!canSave}
                    onClick={() => void save()}
                  >
                    {busy && <Icon icon={Loader2} size={14} className={styles.spin} />}
                    {busy
                      ? t('ui.mascot-theme.onb-checking-provider')
                      : t('ui.mascot-theme.onb-check-and-save')}
                  </button>
                  {usable.length > 0 && (
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => {
                        setEditing(false);
                        setPreset(undefined);
                        setError(null);
                      }}
                    >
                      {t('ui.foundation.cancel')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
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
