/**
 * 图片工作台（整页，侧栏固定入口打开）：左侧历史画廊 + 底部浮动输入区（先选模型 → 再选供应商 →
 * 提示词 → 生成），右侧按 schema 渲染的参数栏 + 任务队列（失败可按快照重试）。
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
import { Button, Icon, Input, Select, Switch, Textarea, t } from '@nomi-ai/ui';
import { Loader2, RotateCcw } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  displayName,
  mediaClient,
  modelName,
  providerName,
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

const STATUS_LABEL: Record<MediaTask['status'], string> = {
  queued: 'ui.mascot-theme.queued',
  running: 'ui.media.generating',
  succeeded: 'ui.foundation.done',
  failed: 'ui.foundation.failed',
};

export const ImageStudio: React.FC<{ active: boolean; prompt?: string }> = ({
  active,
  prompt: initialPrompt,
}) => {
  const open = active;
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

  const submit = async (req: Parameters<typeof mediaClient.start>[0]) => {
    try {
      const task = await mediaClient.start(req);
      setTasks((prev) => [task, ...prev.filter((x) => x.id !== task.id)]);
    } catch (e) {
      mediaToast((e as Error).message || t('ui.media.action-failed'));
    }
  };
  const generate = () =>
    submit({
      modelId,
      providerRef,
      prompt: prompt.trim(),
      params,
      refs: refs.map((assetId) => ({ assetId })),
    });
  // 按快照重试：用失败任务当时的模型 / 供应商 / 提示词 / 参数原样再跑一次
  const retry = (task: MediaTask) =>
    submit({
      modelId: task.modelId,
      providerRef: task.providerRef,
      prompt: task.prompt,
      params: task.params,
    });

  const field = (f: ResolvedField) => (
    <Field key={f.key} f={f} value={params[f.key]} onChange={(v) => change(f.key, v)} />
  );
  type Shot = { key: string; task: MediaTask; asset: MediaAsset | null };
  const shots = tasks.flatMap((task): Shot[] =>
    task.status === 'succeeded'
      ? task.assets.map((a) => ({ key: a.id, task, asset: a }))
      : task.status === 'failed'
        ? []
        : [{ key: task.id, task, asset: null }],
  );

  return (
    <section
      className={styles.studioPage}
      data-testid="image-studio"
      aria-label={t('ui.media.nav-studio')}
    >
      <div className={styles.gallery}>
        <h2 className={styles.pageTitle}>{t('ui.media.nav-studio')}</h2>
        {state.localOnly && <p className={styles.warn}>{t('ui.media.local-only-warning')}</p>}
        {!shots.length ? (
          <p className={styles.muted}>{t('ui.media.studio-empty')}</p>
        ) : (
          <div className={styles.libraryGrid} data-testid="studio-gallery">
            {shots.map(({ key, task, asset }) => (
              <figure key={key} className={styles.tile}>
                {asset ? (
                  <MediaImageMenu src={asset.url} source="studio">
                    <img
                      src={asset.url}
                      alt={task.prompt}
                      className={styles.tileImg}
                      loading="lazy"
                    />
                  </MediaImageMenu>
                ) : (
                  <div className={styles.tilePending}>
                    <Icon icon={Loader2} size={18} className={styles.spin} />
                  </div>
                )}
                <figcaption className={styles.tileMeta} title={task.prompt}>
                  {task.prompt}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        <div className={styles.composer}>
          <div className={styles.pickers}>
            <Select
              size="sm"
              value={modelId}
              aria-label={t('ui.media.assign-model')}
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
            <Select
              size="sm"
              value={providerRef}
              aria-label={t('ui.media.choose-provider')}
              options={providers.map((p) => ({
                value: p.id,
                label: t('ui.media.via-provider', displayName(p.name)),
              }))}
              placeholder={
                providers.length
                  ? t('ui.media.choose-provider')
                  : t('ui.media.configure-provider-in-settings')
              }
              disabled={!providers.length}
              onChange={(e) => setProviderRef(e.target.value)}
              data-testid="studio-provider"
            />
          </div>
          <Textarea
            className={styles.promptInput}
            value={prompt}
            rows={2}
            placeholder={t('ui.media.prompt-placeholder')}
            onChange={(e) => setPrompt(e.target.value)}
            data-testid="studio-prompt"
          />
          <div className={styles.composerRow}>
            <span className={styles.meta}>
              {refs.length ? `${t('ui.media.ref-image')} ${refs.length}/${maxRefs}` : ''}
            </span>
            <Button
              variant="primary"
              disabled={!modelId || !providerRef || !prompt.trim()}
              onClick={() => void generate()}
              data-testid="studio-generate"
            >
              {t('ui.media.generate')}
            </Button>
          </div>
        </div>
      </div>
      <aside className={styles.side} data-testid="studio-params">
        <h3 className={styles.sideTitle}>{t('ui.media.params-title')}</h3>
        {layout?.basic.map(field)}
        {!!layout?.advanced.length && (
          <details className={styles.advanced}>
            <summary>{t('ui.media.advanced')}</summary>
            {layout.advanced.map(field)}
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
        <h3 className={styles.sideTitle}>{t('ui.media.task-queue')}</h3>
        {!tasks.length && <p className={styles.muted}>{t('ui.media.queue-empty')}</p>}
        <div className={styles.queue} data-testid="studio-queue">
          {tasks.slice(0, 30).map((task) => (
            <div key={task.id} className={styles.taskCard} data-status={task.status}>
              <div className={styles.taskHead}>
                <span className={styles.taskStatus} data-status={task.status}>
                  {(task.status === 'running' || task.status === 'queued') && (
                    <Icon icon={Loader2} size={12} className={styles.spin} />
                  )}
                  {t(STATUS_LABEL[task.status])}
                </span>
                <span className={styles.meta}>
                  {modelName(state, task.modelId)} · {providerName(state, task.providerRef)}
                </span>
              </div>
              <div className={styles.prompt}>{task.prompt}</div>
              {task.status === 'failed' && (
                <>
                  <div className={styles.warn}>{task.error?.message}</div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void retry(task)}
                    data-testid="studio-retry"
                  >
                    <Icon icon={RotateCcw} size={12} />
                    {t('ui.media.retry-snapshot')}
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      </aside>
    </section>
  );
};
