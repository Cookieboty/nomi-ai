/**
 * 内联的「添加第三方供应商」表单（不弹窗）：选预设或自定义地址 → 填 Key → 检测并保存。
 * 设置 →「模型」页与新手引导共用；保存后由调用方接着让用户选模型。
 * 本机 / 局域网地址要先确认才会被访问（§15）：本地服务预设自动确认，自定义地址弹窗确认。
 * 可一次填多个 Key（空格、逗号或换行分隔），依次成为主 Key 与备用 Key。
 */
import { BrandIcon, Icon, t } from '@nomi-ai/ui';
import { Globe, Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  gatewayClient,
  hostPortOf,
  isPrivateUrl,
  WIRE_LABEL,
  WIRES,
  type ProviderView,
} from '../../services/gatewayClient';
import {
  providerClient,
  providerClientAvailable,
  type ProviderPreset,
} from '../../services/providerClient';

import styles from './ProviderForm.module.css';
import {
  defaultEnabled,
  groupOf,
  modelRows,
  presetUrls,
  recommendedOf,
  saveDetectedProvider,
} from './providerSetup';

interface Props {
  /** data-testid 前缀：引导里是 onb，模型页是 models */
  idPrefix: string;
  onSaved: (p: ProviderView) => void;
  /** 有就显示「取消」 */
  onCancel?: () => void;
}

export const ProviderForm: React.FC<Props> = ({ idPrefix, onSaved, onCancel }) => {
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  /** undefined：还没选；null：自定义地址 */
  const [preset, setPreset] = useState<ProviderPreset | null | undefined>(undefined);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);

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

  const ordered = useMemo(
    () =>
      [...presets].sort((a, b) => Number(groupOf(a) === 'local') - Number(groupOf(b) === 'local')),
    [presets],
  );

  const custom = preset === null;
  const needsKey = custom || Boolean(preset?.requiresApiKey);
  const baseUrl = custom ? url.trim() : (preset?.baseURL ?? '');
  const keys = key.split(/[\s,]+/).filter(Boolean);
  const canSave = preset !== undefined && baseUrl.length > 0 && (!needsKey || keys.length) && !busy;

  const choose = (p: ProviderPreset | null | undefined) => {
    setPreset(p);
    setError(null);
    setReasons([]);
  };

  const save = async () => {
    if (preset === undefined) return;
    setBusy(true);
    setError(null);
    setReasons([]);
    try {
      if (isPrivateUrl(baseUrl)) {
        const hp = hostPortOf(baseUrl);
        if (hp) {
          if (custom && !window.confirm(t('ui.models.is-a-local-or-lan-address-allow-nomi', hp)))
            return;
          await gatewayClient.confirmPrivateHost(hp);
        }
      }
      const result = await gatewayClient.detect({
        ...(preset ? { urls: presetUrls(preset) } : { url: baseUrl }),
        keys,
        fallbackModel: recommendedOf(preset)[0] || undefined,
      });
      if (!WIRES.some((w) => result.wires[w]?.ok)) {
        setError(t('ui.models.no-api-is-available-so-this-can-t'));
        setReasons(
          WIRES.flatMap((w) => {
            const l = result.wires[w];
            return l?.error ? [`${WIRE_LABEL[w]}：${l.error}`] : [];
          }),
        );
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
      setPreset(undefined);
      setKey('');
      setUrl('');
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.root} data-testid={`${idPrefix}-provider-picker`}>
      <div className={styles.chips} role="radiogroup">
        {ordered.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={preset?.id === p.id}
            className={`${styles.chip} ${preset?.id === p.id ? styles.chipOn : ''}`}
            data-testid={`${idPrefix}-preset-${p.id}`}
            onClick={() => choose(p)}
          >
            <BrandIcon brand={p.icon ?? p.id} name={p.name} size={16} />
            <span>{p.name}</span>
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          className={`${styles.chip} ${custom ? styles.chipOn : ''}`}
          data-testid={`${idPrefix}-preset-custom`}
          onClick={() => choose(null)}
        >
          <Icon icon={Globe} size={16} />
          <span>{t('ui.models.custom-address')}</span>
        </button>
      </div>
      {preset !== undefined && (
        <div className={styles.form} data-testid={`${idPrefix}-provider-form`}>
          {custom && (
            <input
              className={styles.input}
              data-testid={`${idPrefix}-provider-url`}
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
              data-testid={`${idPrefix}-provider-key`}
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
              data-testid={`${idPrefix}-provider-save`}
              disabled={!canSave}
              onClick={() => void save()}
            >
              {busy && <Icon icon={Loader2} size={14} className={styles.spin} />}
              {busy
                ? t('ui.mascot-theme.onb-checking-provider')
                : t('ui.mascot-theme.onb-check-and-save')}
            </button>
            {onCancel && (
              <button
                type="button"
                className={styles.link}
                data-testid={`${idPrefix}-provider-cancel`}
                onClick={() => {
                  choose(undefined);
                  onCancel();
                }}
              >
                {t('ui.foundation.cancel')}
              </button>
            )}
          </div>
        </div>
      )}
      {preset === undefined && onCancel && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.link}
            data-testid={`${idPrefix}-provider-cancel`}
            onClick={onCancel}
          >
            {t('ui.foundation.cancel')}
          </button>
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert" data-testid={`${idPrefix}-provider-error`}>
          <p>{error}</p>
          {reasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
        </div>
      )}
    </div>
  );
};
