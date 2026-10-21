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
type PresetGroup = 'vendor' | 'platform' | 'local';

const GROUP_LABEL: Record<PresetGroup, string> = {
  vendor: '模型厂商',
  platform: '中转平台',
  local: '本地服务',
};

const PROTOCOL_WIRE: Record<Protocol, Wire> = {
  anthropic: 'messages',
  'openai-responses': 'responses',
  'openai-chat': 'chat',
};

/** 不能用来对话的模型（图像、向量、语音等）：列出来但默认不启用，也不给编程助手选 */
const NON_CHAT = /image|embed|tts|whisper|dall-e|audio|speech|video|seedance|rerank|moderation/i;

const groupOf = (p: ProviderPreset): PresetGroup =>
  !p.requiresApiKey && isPrivateUrl(p.baseURL)
    ? 'local'
    : p.category === 'platform'
      ? 'platform'
      : 'vendor';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (p: ProviderView) => void;
}

/** 关闭即卸载：下次打开是全新的状态 */
export const AddProviderDialog: React.FC<Props> = (props) =>
  props.open ? <AddProviderFlow {...props} /> : null;

interface ModelRow {
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

  const models: ModelRow[] = useMemo(() => {
    if (!result) return [];
    const recommended = new Set([...(preset?.models ?? []), preset?.defaultModel ?? '']);
    const listed = result.models.length
      ? result.models
      : [...(preset?.models ?? []), testModel.trim()].filter(Boolean);
    return [...new Set(listed)].map((id) => ({
      id,
      recommended: recommended.has(id),
      chat: !NON_CHAT.test(id),
    }));
  }, [result, preset, testModel]);

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
    if (custom && !window.confirm(t('「{0}」是本机或局域网地址，允许 Nomi 访问它吗？', hp)))
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
      const r = await gatewayClient.detect({
        url: baseUrl,
        ...(preset ? { urls: { [PROTOCOL_WIRE[preset.protocol]]: preset.baseURL } } : {}),
        keys,
        fallbackModel: testModel.trim() || preset?.defaultModel || undefined,
      });
      setResult(r);
      const rec = new Set(preset?.models ?? []);
      const chatModels = (r.models.length ? r.models : [...rec, testModel.trim()]).filter(
        (id) => id && !NON_CHAT.test(id),
      );
      // 预设推荐的模型在列表里就只默认启用推荐的，否则全部对话模型
      const preferred = chatModels.filter((id) => rec.has(id));
      setEnabled(new Set(preferred.length ? preferred : chatModels));
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
      const list: GatewayModel[] = models.map((m) => ({
        id: m.id,
        enabled: enabled.has(m.id),
        ...(m.chat ? {} : { toolCalling: false }),
      }));
      const saved = await gatewayClient.upsertProvider({
        name: name.trim() || preset?.name || t('自定义供应商'),
        ...(preset ? { presetId: preset.id } : {}),
        urls: result.urls,
        newKeys: keys.map((value) => ({ value })),
        models: list,
        detected,
      });
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
      <span className={styles.stepHint}>{t('第 {0} / 3 步', String(step))}</span>
      {step > 1 && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => setStep((s) => (s - 1) as Step)}
          data-testid="add-provider-back"
        >
          {t('上一步')}
        </Button>
      )}
      <Button variant="secondary" onClick={onClose}>
        {t('取消')}
      </Button>
      {step === 2 && (
        <Button
          variant="primary"
          disabled={!canNext}
          onClick={() => void runDetect()}
          data-testid="add-provider-probe"
        >
          {t('检测')}
        </Button>
      )}
      {step === 3 && (
        <Button
          variant="primary"
          disabled={busy || okWires.length === 0 || enabled.size === 0}
          onClick={() => void save()}
          data-testid="add-provider-save"
        >
          {t('保存')}
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
        title={t('添加第三方供应商')}
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
                placeholder={t('搜索厂商、中转平台或本地服务')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('搜索预设')}
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
                <strong>{t('自定义地址')}</strong>
                <small>{t('任何兼容 Anthropic、OpenAI 或 Gemini 协议的服务')}</small>
              </span>
            </button>
          </div>
        )}

        {step === 2 && (
          <div className={styles.stepBody}>
            <label className={styles.field}>
              <span>{t('名称')}</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('自定义供应商')}
                data-testid="add-provider-name"
              />
            </label>
            {custom ? (
              <label className={styles.field}>
                <span>{t('地址')}</span>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                  data-testid="add-provider-url"
                />
                <small className={styles.help}>
                  {t(
                    '根地址、/v1 或完整的 /v1/chat/completions 都可以，Nomi 会自动找到各协议的地址。',
                  )}
                </small>
              </label>
            ) : (
              <div className={styles.presetUrls}>
                <div>
                  <span className={styles.wireTag}>
                    {WIRE_LABEL[PROTOCOL_WIRE[preset.protocol]]}
                  </span>
                  <code>{preset.baseURL}</code>
                </div>
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
                  placeholder={t('每行一个；第一个是主 Key，其余按顺序作为备用')}
                  data-testid="add-provider-keys"
                />
                {keys.length > 1 && (
                  <small className={styles.help}>
                    {t(
                      '共 {0} 个 Key：1 个主 Key，{1} 个备用',
                      String(keys.length),
                      String(keys.length - 1),
                    )}
                  </small>
                )}
              </label>
            ) : (
              <p className={styles.help}>{t('本地服务不需要 Key。')}</p>
            )}
            <label className={styles.field}>
              <span>{t('测试用模型（可选）')}</span>
              <Input
                value={testModel}
                onChange={(e) => setTestModel(e.target.value)}
                placeholder={preset?.defaultModel || 'model-id'}
                data-testid="add-provider-test-model"
              />
              <small className={styles.help}>
                {t('服务不提供模型列表时，用这个模型名检测，并加入模型列表。')}
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
              <p className={styles.error}>
                {t('所有协议都不可用，不能保存。请检查上面每一条的原因。')}
              </p>
            )}
            {result && okWires.length > 0 && models.length === 0 && (
              <p className={styles.error}>{t('没有拿到模型列表。请返回上一步填写测试用模型。')}</p>
            )}
            {result && okWires.length > 0 && models.length > 0 && (
              <>
                <div className={styles.modelsHead}>
                  <span>{t('发现 {0} 个模型', String(models.length))}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEnabled(new Set(models.filter((x) => x.chat).map((x) => x.id)))
                    }
                  >
                    {t('全部启用')}
                  </Button>
                  {models.some((x) => x.recommended) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setEnabled(new Set(models.filter((x) => x.recommended).map((x) => x.id)))
                      }
                    >
                      {t('只启用推荐的')}
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
                      {x.recommended && <span className={styles.badgeSoft}>{t('推荐')}</span>}
                      {!x.chat && <span className={styles.badgeMuted}>{t('不支持工具调用')}</span>}
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
