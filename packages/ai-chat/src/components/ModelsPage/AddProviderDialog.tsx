/**
 * 添加第三方供应商（§4.2）：三步，没有协议字段。
 *   1. 选来源：搜索预设（厂商 / 中转平台 / 本地服务），或自定义地址；
 *   2. 填凭据：可一次粘贴多个 Key（每行一个，依次成为主 Key 与备用 Key）；自定义地址贴什么形式都行；
 *   3. 检测并选模型：并行探测四种协议，至少一种可用才能保存。
 */
import { BrandIcon, Button, Icon, Input, Modal, ModalHostContext, Textarea, t } from '@nomi-ai/ui';
import { Check, Globe, Loader2, Minus, Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  fakeProbe,
  PRESET_GROUP_LABEL,
  PRESETS,
  WIRE_LABEL,
  type PresetGroup,
  type ProbeLine,
  type ProtoModel,
  type ProtoPreset,
  type ProtoProvider,
} from './fakeData';
import styles from './index.module.css';

type Step = 1 | 2 | 3;

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (p: ProtoProvider) => void;
}

/** 关闭即卸载：下次打开是全新的状态 */
export const AddProviderDialog: React.FC<Props> = (props) =>
  props.open ? <AddProviderFlow {...props} /> : null;

const AddProviderFlow: React.FC<Props> = ({ open, onClose, onSave }) => {
  const [step, setStep] = useState<Step>(1);
  const [query, setQuery] = useState('');
  const [preset, setPreset] = useState<ProtoPreset | null>(null);
  const [custom, setCustom] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [keysText, setKeysText] = useState('');
  const [probe, setProbe] = useState<{ lines: ProbeLine[]; models: ProtoModel[] } | null>(null);
  const [shown, setShown] = useState(0);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());

  const keys = keysText
    .split('\n')
    .map((k) => k.trim())
    .filter(Boolean);
  const needsKey = custom || (preset?.needsKey ?? true);

  // 探测结果按各协议的耗时逐条出现，模拟并行请求陆续返回
  useEffect(() => {
    if (step !== 3 || !probe) return;
    const timers = [...probe.lines]
      .map((l, i) => ({ i, ms: l.ms }))
      .sort((a, b) => a.ms - b.ms)
      .map((x, n) => setTimeout(() => setShown(n + 1), x.ms));
    return () => timers.forEach(clearTimeout);
  }, [step, probe]);
  const finished = probe ? shown >= probe.lines.length : false;
  const okLines = probe?.lines.filter((l) => l.ok) ?? [];
  const visible = useMemo(() => {
    if (!probe) return new Set<ProbeLine>();
    return new Set([...probe.lines].sort((a, b) => a.ms - b.ms).slice(0, shown));
  }, [probe, shown]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = PRESETS.filter((p) =>
      `${p.name} ${p.id} ${p.keywords ?? ''}`.toLowerCase().includes(q),
    );
    return (Object.keys(PRESET_GROUP_LABEL) as PresetGroup[])
      .map((g) => ({ g, items: list.filter((p) => p.group === g) }))
      .filter((x) => x.items.length);
  }, [query]);

  const choose = (p: ProtoPreset | null) => {
    setPreset(p);
    setCustom(p === null);
    setName(p?.name ?? '');
    setStep(2);
  };

  const runProbe = () => {
    const r = fakeProbe(preset, url, keys);
    setShown(0);
    setProbe(r);
    setEnabled(new Set(r.models.filter((x) => x.toolCalling !== false).map((x) => x.id)));
    setStep(3);
  };

  const save = () => {
    if (!probe) return;
    onSave({
      id: `${(preset?.id ?? (name || 'custom')).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${Date.now().toString(36).slice(-4)}`,
      name: name.trim() || preset?.name || t('自定义供应商'),
      brand: preset?.brand,
      wires: okLines.map((l) => l.wire),
      keys: keys.length
        ? keys.map((k, i) => ({
            name: i === 0 ? t('主 Key') : t('备用 Key {0}', String(i)),
            masked: `${k.slice(0, 3)}…${k.slice(-4)}`,
          }))
        : [{ name: t('无需 Key'), masked: '—' }],
      models: probe.models.map((x) => ({ ...x, enabled: enabled.has(x.id) })),
    });
  };

  const canNext =
    step === 2 && (custom ? url.trim().length > 0 : true) && (!needsKey || keys.length > 0);

  const footer = (
    <div className={styles.dialogFooter}>
      <span className={styles.stepHint}>{t('第 {0} / 3 步', String(step))}</span>
      {step > 1 && (
        <Button
          variant="ghost"
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
          onClick={runProbe}
          data-testid="add-provider-probe"
        >
          {t('检测')}
        </Button>
      )}
      {step === 3 && (
        <Button
          variant="primary"
          disabled={!finished || okLines.length === 0 || enabled.size === 0}
          onClick={save}
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
                <div className={styles.groupTitle}>{t(PRESET_GROUP_LABEL[g])}</div>
                <div className={styles.presetGrid}>
                  {items.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={styles.presetCard}
                      onClick={() => choose(p)}
                      data-testid={`preset-${p.id}`}
                    >
                      <BrandIcon brand={p.brand} name={p.name} size={22} />
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
                {Object.entries(preset?.urls ?? {}).map(([w, u]) => (
                  <div key={w}>
                    <span className={styles.wireTag}>
                      {WIRE_LABEL[w as keyof typeof WIRE_LABEL]}
                    </span>
                    <code>{u}</code>
                  </div>
                ))}
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
          </div>
        )}

        {step === 3 && probe && (
          <div className={styles.stepBody}>
            <div className={styles.probe} data-testid="add-provider-probe-result">
              {probe.lines.map((l) => {
                const done = l.skipped || visible.has(l);
                const state = !done ? undefined : l.skipped ? 'skip' : l.ok ? 'ok' : 'fail';
                return (
                  <div key={l.wire} className={styles.probeLine} data-state={state}>
                    <span className={styles.probeIcon}>
                      {!done ? (
                        <Icon icon={Loader2} size={14} className={styles.spin} />
                      ) : l.skipped ? (
                        <Icon icon={Minus} size={14} />
                      ) : l.ok ? (
                        <Icon icon={Check} size={14} />
                      ) : (
                        <Icon icon={X} size={14} />
                      )}
                    </span>
                    <span className={styles.probeWire}>{WIRE_LABEL[l.wire]}</span>
                    <code className={styles.probeUrl}>{l.url}</code>
                    <span className={styles.probeReason}>
                      {done && !l.ok ? t(l.reason ?? '') : ''}
                    </span>
                  </div>
                );
              })}
            </div>
            {finished && okLines.length === 0 && (
              <p className={styles.error}>
                {t('所有协议都不可用，不能保存。请检查上面每一条的原因。')}
              </p>
            )}
            {finished && probe.models.length > 0 && (
              <>
                <div className={styles.modelsHead}>
                  <span>{t('发现 {0} 个模型', String(probe.models.length))}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEnabled(new Set(probe.models.map((x) => x.id)))}
                  >
                    {t('全部启用')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEnabled(
                        new Set(probe.models.filter((x) => x.recommended).map((x) => x.id)),
                      )
                    }
                  >
                    {t('只启用推荐的')}
                  </Button>
                </div>
                <div className={styles.modelChecks}>
                  {probe.models.map((x) => (
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
                      {x.toolCalling === false && (
                        <span className={styles.badgeMuted}>{t('不支持工具调用')}</span>
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
