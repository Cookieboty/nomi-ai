/**
 * 图片工作台（P0 简版）：先选模型 → 再选供应商 → 提示词 + 按 schema 渲染的参数 → 生成。
 * 记住上次选择（studioLast，由主进程在成功后写入）；任务异步，结果经 ai:media:task 推送。
 */
import {
  clampOnChange,
  initialParams,
  layoutProperties,
  migrateParams,
  type MediaParams,
  type ParamValue,
  type ResolvedField,
} from '@nomi-ai/gateway/media';
import { Button, Icon, Input, Modal, Select, Switch, Textarea, t } from '@nomi-ai/ui';
import { Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  displayName,
  mediaClient,
  mediaToast,
  useMediaState,
  type MediaAsset,
  type MediaState,
  type MediaTask,
} from '../../services/mediaClient';

import styles from './Media.module.css';
import { MediaImageMenu } from './MediaImageMenu';

function usable(s: MediaState, modelId: string) {
  return s.bindings
    .filter((b) => b.modelId === modelId && b.enabled)
    .map((b) => s.providers.find((p) => p.id === b.providerRef))
    .filter((p): p is NonNullable<typeof p> => !!p && p.enabled && p.hasKey);
}

const label = (k: string) => (k.startsWith('ui.') ? t(k) : k);

const Field: React.FC<{
  f: ResolvedField;
  value: ParamValue | undefined;
  onChange: (v: ParamValue | undefined) => void;
}> = ({ f, value, onChange }) => {
  const ui = f['x-ui'];
  const optLabel = (v: ParamValue) => label(ui.optionLabels?.[String(v)] ?? String(v));
  let control: React.ReactNode;
  if (ui.control === 'switch' || f.type === 'boolean')
    control = (
      <Switch checked={value === true} onChange={(v) => onChange(v)} aria-label={label(ui.label)} />
    );
  else if (f.enum && (ui.control === 'chips' || ui.control === 'select'))
    control =
      ui.control === 'chips' ? (
        <div className={styles.chips} role="radiogroup" aria-label={label(ui.label)}>
          {f.enum.map((v) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={value === v}
              className={`${styles.chip} ${value === v ? styles.chipOn : ''}`}
              onClick={() => onChange(v)}
            >
              {optLabel(v)}
            </button>
          ))}
        </div>
      ) : (
        <Select
          size="sm"
          value={String(value ?? '')}
          options={f.enum.map((v) => ({ value: String(v), label: optLabel(v) }))}
          onChange={(e) => {
            const hit = f.enum!.find((v) => String(v) === e.target.value);
            onChange(hit);
          }}
          aria-label={label(ui.label)}
        />
      );
  else if (f.type === 'integer' || f.type === 'number')
    control = (
      <Input
        size="sm"
        type="number"
        min={f.minimum}
        max={f.maximum}
        step={ui.step ?? (f.type === 'integer' ? 1 : 0.1)}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        aria-label={label(ui.label)}
      />
    );
  else
    control = (
      <Input
        size="sm"
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value || undefined)}
        aria-label={label(ui.label)}
      />
    );
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label(ui.label)}</span>
      {control}
    </label>
  );
};

export const ImageStudio: React.FC<{ open: boolean; onClose: () => void; prompt?: string }> = ({
  open,
  onClose,
  prompt: initialPrompt,
}) => {
  const [state] = useMediaState();
  const [modelId, setModelId] = useState('');
  const [providerRef, setProviderRef] = useState('');
  const [params, setParams] = useState<MediaParams>({});
  const [prompt, setPrompt] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [library, setLibrary] = useState<MediaAsset[]>([]);
  const [tasks, setTasks] = useState<MediaTask[]>([]);
  const [inited, setInited] = useState(false);

  // 初始：上次的选择（参数按当前 schema 迁移），否则第一个有可用供应商的模型
  useEffect(() => {
    if (!open || !state || inited) return;
    const last = state.prefs.studioLast;
    const spec =
      (last && state.models.find((m) => m.id === last.modelId)) ||
      state.models.find((m) => usable(state, m.id).length) ||
      state.models[0];
    if (spec) {
      setModelId(spec.id);
      const ps = usable(state, spec.id);
      setProviderRef(
        last && last.modelId === spec.id && ps.some((p) => p.id === last.providerRef)
          ? last.providerRef
          : (ps[0]?.id ?? ''),
      );
      setParams(
        last?.params && last.modelId === spec.id
          ? migrateParams(spec, last.params, state.prefs.userDefaults[spec.id]).params
          : initialParams(spec, state.prefs.userDefaults[spec.id]),
      );
    }
    setInited(true);
  }, [open, state, inited]);

  useEffect(() => {
    if (open && initialPrompt) setPrompt(initialPrompt);
  }, [open, initialPrompt]);

  useEffect(() => {
    if (!open || !mediaClient.available()) return;
    void mediaClient
      .tasks()
      .then((ts) => setTasks(ts.filter((x) => x.surface === 'studio')))
      .catch(() => undefined);
    void mediaClient
      .assets()
      .then(setLibrary)
      .catch(() => undefined);
    return mediaClient.onTask((task) => {
      if (task.surface !== 'studio') return;
      setTasks((prev) => [task, ...prev.filter((x) => x.id !== task.id)]);
      if (task.status === 'failed' && task.error) mediaToast(task.error.message);
    });
  }, [open]);

  const spec = state?.models.find((m) => m.id === modelId);
  const layout = useMemo(
    () => (spec ? layoutProperties(spec, params, 'studio') : null),
    [spec, params],
  );
  if (!state) return null;
  const providers = modelId ? usable(state, modelId) : [];
  const maxRefs = spec?.['x-media']?.image?.max ?? 0;

  const pickModel = (id: string) => {
    const to = state.models.find((m) => m.id === id);
    if (!to) return;
    setModelId(id);
    setProviderRef(usable(state, id)[0]?.id ?? '');
    setParams(migrateParams(to, params, state.prefs.userDefaults[id]).params);
    setRefs((r) => r.slice(0, to['x-media']?.image?.max ?? 0));
  };

  const change = (key: string, v: ParamValue | undefined) => {
    if (!spec) return;
    setParams(clampOnChange(spec, params, key, v).params);
  };

  const generate = async () => {
    try {
      const task = await mediaClient.start({
        modelId,
        providerRef,
        prompt: prompt.trim(),
        params,
        refs: refs.map((assetId) => ({ assetId })),
      });
      setTasks((prev) => [task, ...prev.filter((x) => x.id !== task.id)]);
    } catch (e) {
      mediaToast((e as Error).message || t('ui.media.action-failed'));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('ui.media.nav-studio')}
      data-testid="image-studio"
    >
      <div className={styles.studio}>
        <div className={styles.studioForm}>
          {state.localOnly && <p className={styles.warn}>{t('ui.media.local-only-warning')}</p>}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('ui.media.assign-model')}</span>
            <Select
              size="sm"
              value={modelId}
              options={state.models.map((m) => ({
                value: m.id,
                label: m.name,
                description: usable(state, m.id).length
                  ? undefined
                  : t('ui.media.no-usable-provider'),
              }))}
              onChange={(e) => pickModel(e.target.value)}
              data-testid="studio-model"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('ui.media.choose-provider')}</span>
            <Select
              size="sm"
              value={providerRef}
              options={providers.map((p) => ({ value: p.id, label: displayName(p.name) }))}
              placeholder={
                providers.length
                  ? t('ui.media.choose-provider')
                  : t('ui.media.configure-provider-in-settings')
              }
              disabled={!providers.length}
              onChange={(e) => setProviderRef(e.target.value)}
              data-testid="studio-provider"
            />
          </label>
          <Textarea
            className={styles.promptInput}
            value={prompt}
            rows={4}
            placeholder={t('ui.media.prompt-placeholder')}
            onChange={(e) => setPrompt(e.target.value)}
            data-testid="studio-prompt"
          />
          {layout?.basic.map((f) => (
            <Field key={f.key} f={f} value={params[f.key]} onChange={(v) => change(f.key, v)} />
          ))}
          {!!layout?.advanced.length && (
            <details className={styles.advanced}>
              <summary>{t('ui.media.advanced')}</summary>
              {layout.advanced.map((f) => (
                <Field key={f.key} f={f} value={params[f.key]} onChange={(v) => change(f.key, v)} />
              ))}
            </details>
          )}
          {maxRefs > 0 && library.length > 0 && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>
                {label(spec?.['x-media']?.image?.label ?? 'ui.media.ref-image')} ({refs.length}/
                {maxRefs})
              </span>
              <div className={styles.refPicker}>
                {library.slice(0, 24).map((a) => {
                  const on = refs.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={`${styles.refThumb} ${on ? styles.refOn : ''}`}
                      aria-pressed={on}
                      disabled={!on && refs.length >= maxRefs}
                      onClick={() =>
                        setRefs((r) => (on ? r.filter((x) => x !== a.id) : [...r, a.id]))
                      }
                    >
                      <img src={a.url} alt="" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <Button
            variant="primary"
            disabled={!modelId || !providerRef || !prompt.trim()}
            onClick={() => void generate()}
            data-testid="studio-generate"
          >
            {t('ui.media.generate')}
          </Button>
        </div>
        <div className={styles.studioResults}>
          {!tasks.length && <p className={styles.muted}>{t('ui.media.studio-empty')}</p>}
          {tasks.map((task) => (
            <div key={task.id} className={styles.taskCard} data-status={task.status}>
              <div className={styles.prompt}>{task.prompt}</div>
              {(task.status === 'running' || task.status === 'queued') && (
                <div className={styles.cardHead}>
                  <Icon icon={Loader2} size={14} className={styles.spin} />
                  {t('ui.media.generating')}
                </div>
              )}
              {task.status === 'failed' && <div className={styles.warn}>{task.error?.message}</div>}
              <div className={styles.grid}>
                {task.assets.map((a) => (
                  <MediaImageMenu key={a.id} src={a.url} source="studio">
                    <img src={a.url} alt={task.prompt} className={styles.genImg} />
                  </MediaImageMenu>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
};
