/**
 * 「添加第三方供应商」表单，两步：先在按官方厂商 / 三方平台 / 本地 / 其他分组的卡片里选一家，
 * 再填 Key（自定义地址还要填地址）→ 检测并保存。
 * 设置 →「模型」页（弹窗）与新手引导（内联）共用；保存后由调用方接着让用户选模型。
 * 本机 / 局域网地址要先确认才会被访问：本地服务预设自动确认，自定义地址弹窗确认。
 * 可一次填多个 Key（空格、逗号或换行分隔），依次成为主 Key 与备用 Key。
 */
import { BrandIcon, Button, FormField, Icon, Input, t } from '@nomi-ai/ui';
import { ArrowLeft, Globe, Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

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
import { confirmDialog } from '../ConfirmDialog';

import styles from './ProviderForm.module.css';
import {
  defaultEnabled,
  groupOf,
  modelRows,
  presetUrls,
  recommendedOf,
  saveDetectedProvider,
} from './providerSetup';

/** 第一步的分组：官方厂商（模型厂商自己的 API / 套餐）、三方平台（聚合）、本地服务；「其他」是自定义地址 */
const GROUPS = [
  {
    id: 'vendor',
    label: 'ui.models.preset-group-vendor',
    hint: 'ui.models.preset-group-vendor-hint',
  },
  {
    id: 'platform',
    label: 'ui.models.preset-group-platform',
    hint: 'ui.models.preset-group-platform-hint',
  },
  { id: 'local', label: 'ui.providers-schedule.local', hint: 'ui.models.preset-group-local-hint' },
] as const;

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
  /** 自定义地址的显示名；空着用「自定义供应商」 */
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  /** 可选：/models 失败时用于探测与待保存模型（#161） */
  const [testModel, setTestModel] = useState('');
  /** 取消 / 卸载时递增，作废进行中的 detect（#162） */
  const opGen = useRef(0);

  useEffect(() => {
    if (!providerClientAvailable()) return;
    let alive = true;
    providerClient
      .presets()
      .then((ps) => alive && setPresets(ps.filter((p) => p.category !== 'custom')))
      .catch(() => undefined);
    return () => {
      alive = false;
      opGen.current += 1;
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

  const abortOp = () => {
    opGen.current += 1;
  };

  const save = async () => {
    if (preset === undefined) return;
    const gen = ++opGen.current;
    setBusy(true);
    setError(null);
    setReasons([]);
    try {
      if (isPrivateUrl(baseUrl)) {
        const hp = hostPortOf(baseUrl);
        if (hp) {
          if (
            custom &&
            !(await confirmDialog({
              message: t('ui.models.is-a-local-or-lan-address-allow-nomi', hp),
            }))
          )
            return;
          await gatewayClient.confirmPrivateHost(hp);
        }
      }
      if (gen !== opGen.current) return;
      const hand = testModel.trim();
      const result = await gatewayClient.detect({
        ...(preset ? { urls: presetUrls(preset) } : { url: baseUrl }),
        keys,
        fallbackModel: recommendedOf(preset)[0] || hand || undefined,
      });
      if (gen !== opGen.current) return;
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
      const rows = modelRows(result, preset, hand);
      if (!rows.some((r) => r.chat)) {
        setError(t('ui.models.no-model-list-was-returned-go-back-and'));
        return;
      }
      const saved = await saveDetectedProvider({
        result,
        preset,
        name: preset?.name ?? name,
        keys,
        models: rows,
        enabled: defaultEnabled(rows),
      });
      if (gen !== opGen.current) return;
      setPreset(undefined);
      setKey('');
      setUrl('');
      setName('');
      setTestModel('');
      onSaved(saved);
    } catch (e) {
      if (gen !== opGen.current) return;
      setError((e as Error).message);
    } finally {
      if (gen === opGen.current) setBusy(false);
    }
  };

  const cancel = onCancel && (
    <Button
      size="sm"
      variant="ghost"
      data-testid={`${idPrefix}-provider-cancel`}
      onClick={() => {
        abortOp();
        choose(undefined);
        onCancel();
      }}
    >
      {t('ui.foundation.cancel')}
    </Button>
  );

  // 第二步：选好后只显示这一家和要填的字段，「重新选择」回到列表
  if (preset !== undefined)
    return (
      <div className={styles.root} data-testid={`${idPrefix}-provider-picker`}>
        <div className={styles.chosen}>
          <span className={styles.chosenName}>
            {custom ? (
              <Icon icon={Globe} size={20} />
            ) : (
              <BrandIcon brand={preset.icon ?? preset.id} name={preset.name} size={20} />
            )}
            {custom ? t('ui.models.custom-address') : preset.name}
          </span>
          <Button
            size="sm"
            variant="ghost"
            data-testid={`${idPrefix}-provider-back`}
            onClick={() => {
              abortOp();
              setBusy(false);
              choose(undefined);
            }}
          >
            <Icon icon={ArrowLeft} size={14} />
            {t('ui.models.choose-again')}
          </Button>
        </div>
        <div className={styles.form} data-testid={`${idPrefix}-provider-form`}>
          {custom && (
            <FormField label={t('ui.models.address')}>
              <Input
                data-testid={`${idPrefix}-provider-url`}
                value={url}
                placeholder="https://api.example.com/v1"
                onChange={(e) => setUrl(e.target.value)}
              />
            </FormField>
          )}
          {custom && (
            <FormField label={t('ui.models.provider-name-optional')}>
              <Input
                data-testid={`${idPrefix}-provider-name`}
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>
          )}
          {needsKey ? (
            <FormField label={t('API Key')} hint={t('ui.models.multi-key-hint')}>
              <Input
                type="password"
                data-testid={`${idPrefix}-provider-key`}
                value={key}
                autoComplete="off"
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canSave && void save()}
              />
            </FormField>
          ) : (
            <p className={styles.note}>{t('ui.models.local-services-don-t-need-a-key')}</p>
          )}
          <FormField
            label={t('ui.models.test-model-optional')}
            hint={t('ui.models.test-model-hint')}
          >
            <Input
              data-testid={`${idPrefix}-provider-test-model`}
              value={testModel}
              onChange={(e) => setTestModel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canSave && void save()}
            />
          </FormField>
        </div>
        {error && (
          <div className={styles.error} role="alert" data-testid={`${idPrefix}-provider-error`}>
            <p>{error}</p>
            {reasons.map((r) => (
              <p key={r}>{r}</p>
            ))}
          </div>
        )}
        <div className={styles.actions}>
          {cancel}
          <Button
            size="sm"
            variant="primary"
            data-testid={`${idPrefix}-provider-save`}
            disabled={!canSave}
            onClick={() => void save()}
          >
            {busy && <Icon icon={Loader2} size={14} className={styles.spin} />}
            {busy
              ? t('ui.mascot-theme.onb-checking-provider')
              : t('ui.mascot-theme.onb-check-and-save')}
          </Button>
        </div>
      </div>
    );

  // 第一步：按官方厂商 / 三方平台 / 本地 / 其他分组的卡片
  const card = (p: ProviderPreset) => (
    <button
      key={p.id}
      type="button"
      className={styles.card}
      data-testid={`${idPrefix}-preset-${p.id}`}
      onClick={() => choose(p)}
    >
      <BrandIcon brand={p.icon ?? p.id} name={p.name} size={20} />
      <span className={styles.cardName}>{p.name}</span>
    </button>
  );
  return (
    <div className={styles.root} data-testid={`${idPrefix}-provider-picker`}>
      {GROUPS.map((g) => {
        const list = ordered.filter((p) => groupOf(p) === g.id);
        if (!list.length) return null;
        return (
          <section key={g.id} className={styles.group} aria-label={t(g.label)}>
            <h4 className={styles.groupTitle}>
              {t(g.label)}
              <span className={styles.groupHint}>{t(g.hint)}</span>
            </h4>
            <div className={styles.grid}>{list.map(card)}</div>
          </section>
        );
      })}
      <section className={styles.group} aria-label={t('ui.models.preset-group-custom')}>
        <h4 className={styles.groupTitle}>
          {t('ui.models.preset-group-custom')}
          <span className={styles.groupHint}>{t('ui.models.preset-group-custom-hint')}</span>
        </h4>
        <div className={styles.grid}>
          <button
            type="button"
            className={styles.card}
            data-testid={`${idPrefix}-preset-custom`}
            onClick={() => choose(null)}
          >
            <Icon icon={Globe} size={20} />
            <span className={styles.cardName}>{t('ui.models.custom-address')}</span>
          </button>
        </div>
      </section>
      {cancel && <div className={styles.actions}>{cancel}</div>}
    </div>
  );
};
