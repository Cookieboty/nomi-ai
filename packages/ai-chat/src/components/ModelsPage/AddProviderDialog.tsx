/**
 * 添加第三方供应商（§4.2）：三步，没有协议字段。
 *   1. 选来源：搜索预设（厂商 / 中转平台 / 本地服务），或自定义地址；
 *   2. 填凭据：可一次粘贴多个 Key（每行一个，依次成为主 Key 与备用 Key）；自定义地址贴什么形式都行；
 *   3. 检测并选模型：主进程并行探测四种协议（ai:gateway:detect），至少一种可用才能保存。
 * 本机 / 局域网地址要先确认才会被访问（§15）：本地服务预设自动确认，自定义地址弹窗确认。
 */
import { BrandIcon, Button, Icon, Input, Modal, ModalHostContext, Textarea, t } from '@nomi-ai/ui';
import { Check, Globe, Loader2, Minus, Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  gatewayClient,
  hostPortOf,
  isPrivateUrl,
  WIRE_LABEL,
  WIRES,
  type DetectResult,
  type GatewayModel,
  type ProviderView,
  type StoredProbe,
  type Wire,
} from '../../services/gatewayClient';
import {
  providerClient,
  providerClientAvailable,
  type Protocol,
  type ProviderPreset,
} from '../../services/providerClient';

import styles from './index.module.css';

type Step = 1 | 2 | 3;
export type PresetGroup = 'vendor' | 'platform' | 'local';

export const GROUP_LABEL: Record<PresetGroup, string> = {
  vendor: 'ui.chat-settings.model-vendors',
  platform: 'ui.models.relay-platforms',
  local: 'ui.models.local-services',
};

const PROTOCOL_WIRE: Record<Protocol, Wire> = {
  anthropic: 'messages',
  'openai-responses': 'responses',
  'openai-chat': 'chat',
};

/** 不能用来对话的模型（图像、向量、语音等）：列出来但默认不启用，也不给编程助手选 */
export const NON_CHAT =
  /image|embed|tts|whisper|dall-e|audio|speech|video|seedance|rerank|moderation/i;

/** 探测结果 → 存进供应商的 detected（每种协议最近一次的结果） */
export function storedProbes(result: DetectResult): Partial<Record<Wire, StoredProbe>> {
  const at = Date.now();
  const detected: Partial<Record<Wire, StoredProbe>> = {};
  for (const w of WIRES) {
    const l = result.wires[w];
    if (l)
      detected[w] = {
        ok: l.ok,
        at,
        ...(l.status ? { status: l.status } : {}),
        ...(l.model ? { model: l.model } : {}),
        ...(l.auth ? { auth: l.auth } : {}),
        ...(l.error ? { error: l.error } : {}),
      };
  }
  return detected;
}

/** 预设里各协议的地址：有多地址扩展（§8.4）用它，否则只有 baseURL 那一种 */
export const presetUrls = (p: ProviderPreset): Partial<Record<Wire, string>> =>
  p.urls ?? { [PROTOCOL_WIRE[p.protocol]]: p.baseURL };

/** 预设推荐的模型：整理过元数据的主力模型 */
export const recommendedOf = (p: ProviderPreset | null): string[] =>
  p ? [...(p.modelMeta ?? []).map((m) => m.id), ...p.models] : [];

export const groupOf = (p: ProviderPreset): PresetGroup =>
  !p.requiresApiKey && isPrivateUrl(p.baseURL)
    ? 'local'
    : p.category === 'platform'
      ? 'platform'
      : 'vendor';

/** 探测结果 → 模型行：有模型列表用列表，否则用预设推荐 + 测试模型 */
export function modelRows(
  result: DetectResult,
  preset: ProviderPreset | null,
  testModel = '',
): ModelRow[] {
  const recommended = new Set(recommendedOf(preset));
  const listed = result.models.length
    ? result.models
    : [...recommended, testModel.trim()].filter(Boolean);
  return [...new Set(listed)].map((id) => ({
    id,
    recommended: recommended.has(id),
    chat: !NON_CHAT.test(id),
  }));
}

/** 默认启用的模型：列表里有预设推荐的就只启用推荐的，否则全部对话模型 */
export function defaultEnabled(rows: ModelRow[]): Set<string> {
  const chat = rows.filter((x) => x.chat);
  const preferred = chat.filter((x) => x.recommended);
  return new Set((preferred.length ? preferred : chat).map((x) => x.id));
}

/** 把检测过的供应商存进网关（设置里的模型页与新手引导共用） */
export function saveDetectedProvider(input: {
  result: DetectResult;
  preset: ProviderPreset | null;
  name: string;
  keys: string[];
  models: ModelRow[];
  enabled: Set<string>;
}): Promise<ProviderView> {
  const { result, preset, name, keys, models, enabled } = input;
  const meta = new Map((preset?.modelMeta ?? []).map((m) => [m.id, m]));
  const list: GatewayModel[] = models.map((m) => {
    const known = meta.get(m.id);
    // 预设没整理的，用模型列表接口顺带返回的上限（§12.7.2 第 3 级）
    const listed = known ? undefined : result.limits?.[m.id];
    return {
      id: m.id,
      enabled: enabled.has(m.id),
      // 预设整理过的元数据（§12.7.2 第 2 级）一起存下，编程助手按它注入上下文与输出上限
      ...(known
        ? {
            ctx: known.ctx,
            maxOutput: known.maxOutput,
            reasoning: known.reasoning,
            vision: known.vision,
            toolCalling: known.toolCalling,
            metaSource: 'preset' as const,
          }
        : m.chat
          ? {}
          : { toolCalling: false }),
      ...(listed ? { ...listed, metaSource: 'listed' as const } : {}),
    };
  });
  return gatewayClient.upsertProvider({
    name: name.trim() || preset?.name || t('ui.models.custom-provider'),
    ...(preset ? { presetId: preset.id } : {}),
    ...(preset?.quirks ? { quirks: preset.quirks } : {}),
    urls: result.urls,
    newKeys: keys.map((value) => ({ value })),
    models: list,
    detected: storedProbes(result),
  });
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (p: ProviderView) => void;
}

/** 关闭即卸载：下次打开是全新的状态 */
export const AddProviderDialog: React.FC<Props> = (props) =>
  props.open ? <AddProviderFlow {...props} /> : null;

export interface ModelRow {
  id: string;
  recommended: boolean;
  chat: boolean;
}

const AddProviderFlow: React.FC<Props> = ({ open, onClose, onSaved }) => {
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [step, setStep] = useState<Step>(1);
  const [query, setQuery] = useState('');
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [testModel, setTestModel] = useState('');
  const [keysText, setKeysText] = useState('');
  const [result, setResult] = useState<DetectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());

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

  const custom = preset === null;
  const keys = keysText
    .split('\n')
    .map((k) => k.trim())
    .filter(Boolean);
  const needsKey = custom || preset.requiresApiKey;
  const baseUrl = custom ? url.trim() : preset.baseURL;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = presets.filter((p) =>
      `${p.name} ${p.id} ${(p.keywords ?? []).join(' ')}`.toLowerCase().includes(q),
    );
    return (Object.keys(GROUP_LABEL) as PresetGroup[])
      .map((g) => ({ g, items: list.filter((p) => groupOf(p) === g) }))
      .filter((x) => x.items.length);
  }, [presets, query]);

  const models: ModelRow[] = useMemo(
    () => (result ? modelRows(result, preset, testModel) : []),
    [result, preset, testModel],
  );

  const okWires = WIRES.filter((w) => result?.wires[w]?.ok);

  const choose = (p: ProviderPreset | null) => {
    setPreset(p);
    setName(p?.name ?? '');
    setUrl('');
    setError(null);
    setStep(2);
  };

  /** 本机 / 局域网地址：本地预设自动确认，自定义地址问一次；拒绝则返回 false */
  const confirmPrivate = async (): Promise<boolean> => {
    if (!isPrivateUrl(baseUrl)) return true;
    const hp = hostPortOf(baseUrl);
    if (!hp) return true;
    if (custom && !window.confirm(t('ui.models.is-a-local-or-lan-address-allow-nomi', hp)))
      return false;
    await gatewayClient.confirmPrivateHost(hp);
    return true;
  };

  const runDetect = async () => {
    setError(null);
    setBusy(true);
    setResult(null);
    setStep(3);
    try {
      if (!(await confirmPrivate())) {
        setStep(2);
        return;
      }
      // 预设只测它写明的地址（不再推导别的协议）；自定义地址由主进程推导四种
      const r = await gatewayClient.detect({
        ...(preset ? { urls: presetUrls(preset) } : { url: baseUrl }),
        keys,
        fallbackModel: testModel.trim() || recommendedOf(preset)[0] || undefined,
      });
      setResult(r);
      setEnabled(defaultEnabled(modelRows(r, preset, testModel)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveDetectedProvider({ result, preset, name, keys, models, enabled });
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canNext = step === 2 && baseUrl.length > 0 && (!needsKey || keys.length > 0);

  const footer = (
    <div className={styles.dialogFooter}>
      <span className={styles.stepHint}>{t('ui.models.step-of-3', String(step))}</span>
      {step > 1 && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => setStep((s) => (s - 1) as Step)}
          data-testid="add-provider-back"
        >
          {t('ui.mascot-theme.back')}
        </Button>
      )}
      <Button variant="secondary" onClick={onClose}>
        {t('ui.foundation.cancel')}
      </Button>
      {step === 2 && (
        <Button
          variant="primary"
          disabled={!canNext}
          onClick={() => void runDetect()}
          data-testid="add-provider-probe"
        >
          {t('ui.models.detect')}
        </Button>
      )}
      {step === 3 && (
        <Button
          variant="primary"
          disabled={busy || okWires.length === 0 || enabled.size === 0}
          onClick={() => void save()}
          data-testid="add-provider-save"
        >
          {t('ui.foundation.save')}
        </Button>
      )}
    </div>
  );

  return (
    // 设置页以内嵌方式渲染面板；这个对话框要浮在页面上方
    <ModalHostContext.Provider value={null}>
      <Modal
        open={open}
        onClose={onClose}
        size="lg"
        title={t('ui.models.add-third-party-provider')}
        footer={footer}
        data-testid="add-provider-dialog"
      >
        {step === 1 && (
          <div className={styles.stepBody}>
            <div className={styles.search}>
              <Icon icon={Search} size={14} />
              <input
                className={styles.searchInput}
                autoFocus
                placeholder={t('ui.models.search-vendors-relay-platforms-or-local-services')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('ui.models.search-presets')}
              />
            </div>
            {groups.map(({ g, items }) => (
              <div key={g} className={styles.presetGroup}>
                <div className={styles.groupTitle}>{t(GROUP_LABEL[g])}</div>
                <div className={styles.presetGrid}>
                  {items.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={styles.presetCard}
                      onClick={() => choose(p)}
                      data-testid={`preset-${p.id}`}
                    >
                      <BrandIcon brand={p.icon ?? p.id} name={p.name} size={22} />
                      <span>{p.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button
              type="button"
              className={`${styles.presetCard} ${styles.customCard}`}
              onClick={() => choose(null)}
              data-testid="preset-custom"
            >
              <Icon icon={Globe} size={18} />
              <span>
                <strong>{t('ui.models.custom-address')}</strong>
                <small>{t('ui.models.any-service-compatible-with-the-anthropic-openai-or')}</small>
              </span>
            </button>
          </div>
        )}

        {step === 2 && (
          <div className={styles.stepBody}>
            <label className={styles.field}>
              <span>{t('ui.foundation.name')}</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('ui.models.custom-provider')}
                data-testid="add-provider-name"
              />
            </label>
            {custom ? (
              <label className={styles.field}>
                <span>{t('ui.models.address')}</span>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                  data-testid="add-provider-url"
                />
                <small className={styles.help}>
                  {t('ui.models.a-root-address-v1-or-a-full-v1')}
                </small>
              </label>
            ) : (
              <div className={styles.presetUrls}>
                {Object.entries(presetUrls(preset)).map(([w, u]) => (
                  <div key={w}>
                    <span className={styles.wireTag}>{WIRE_LABEL[w as Wire]}</span>
                    <code>{u}</code>
                  </div>
                ))}
                {preset.hint && <small className={styles.help}>{t(preset.hint)}</small>}
              </div>
            )}
            {needsKey ? (
              <label className={styles.field}>
                <span>{t('API Key')}</span>
                <Textarea
                  rows={3}
                  value={keysText}
                  onChange={(e) => setKeysText(e.target.value)}
                  placeholder={t('ui.models.one-per-line-the-first-is-the-primary')}
                  data-testid="add-provider-keys"
                />
                {keys.length > 1 && (
                  <small className={styles.help}>
                    {t(
                      'ui.models.keys-1-primary-backup',
                      String(keys.length),
                      String(keys.length - 1),
                    )}
                  </small>
                )}
              </label>
            ) : (
              <p className={styles.help}>{t('ui.models.local-services-don-t-need-a-key')}</p>
            )}
            <label className={styles.field}>
              <span>{t('ui.models.test-model-optional')}</span>
              <Input
                value={testModel}
                onChange={(e) => setTestModel(e.target.value)}
                placeholder={recommendedOf(preset)[0] || 'model-id'}
                data-testid="add-provider-test-model"
              />
              <small className={styles.help}>
                {t('ui.models.if-the-service-doesn-t-list-its-models')}
              </small>
            </label>
          </div>
        )}

        {step === 3 && (
          <div className={styles.stepBody}>
            <div className={styles.probe} data-testid="add-provider-probe-result">
              {WIRES.map((w) => {
                const l = result?.wires[w];
                const state = !result ? undefined : !l ? 'skip' : l.ok ? 'ok' : 'fail';
                return (
                  <div key={w} className={styles.probeLine} data-state={state}>
                    <span className={styles.probeIcon}>
                      {!result ? (
                        busy ? (
                          <Icon icon={Loader2} size={14} className={styles.spin} />
                        ) : (
                          <Icon icon={Minus} size={14} />
                        )
                      ) : !l ? (
                        <Icon icon={Minus} size={14} />
                      ) : l.ok ? (
                        <Icon icon={Check} size={14} />
                      ) : (
                        <Icon icon={X} size={14} />
                      )}
                    </span>
                    <span className={styles.probeWire}>{WIRE_LABEL[w]}</span>
                    <code className={styles.probeUrl}>{l?.url ?? '—'}</code>
                    <span className={styles.probeReason}>
                      {l && !l.ok ? (l.error ?? (l.status ? `HTTP ${l.status}` : '')) : ''}
                    </span>
                  </div>
                );
              })}
            </div>
            {error && <p className={styles.error}>{error}</p>}
            {result && okWires.length === 0 && (
              <p className={styles.error}>{t('ui.models.no-api-is-available-so-this-can-t')}</p>
            )}
            {result && okWires.length > 0 && models.length === 0 && (
              <p className={styles.error}>
                {t('ui.models.no-model-list-was-returned-go-back-and')}
              </p>
            )}
            {result && okWires.length > 0 && models.length > 0 && (
              <>
                <div className={styles.modelsHead}>
                  <span>{t('ui.models.found-models', String(models.length))}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEnabled(new Set(models.filter((x) => x.chat).map((x) => x.id)))
                    }
                  >
                    {t('ui.models.enable-all')}
                  </Button>
                  {models.some((x) => x.recommended) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setEnabled(new Set(models.filter((x) => x.recommended).map((x) => x.id)))
                      }
                    >
                      {t('ui.models.enable-recommended-only')}
                    </Button>
                  )}
                </div>
                <div className={styles.modelChecks}>
                  {models.map((x) => (
                    <label key={x.id} className={styles.modelCheck}>
                      <input
                        type="checkbox"
                        checked={enabled.has(x.id)}
                        onChange={(e) => {
                          const next = new Set(enabled);
                          if (e.target.checked) next.add(x.id);
                          else next.delete(x.id);
                          setEnabled(next);
                        }}
                      />
                      <span>{x.id}</span>
                      {x.recommended && (
                        <span className={styles.badgeSoft}>
                          {t('ui.knowledge-local.recommended')}
                        </span>
                      )}
                      {!x.chat && (
                        <span className={styles.badgeMuted}>{t('ui.models.no-tool-calling')}</span>
                      )}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </ModalHostContext.Provider>
  );
};
