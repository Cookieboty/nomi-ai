/**
 * 设置 → 模型：「按任务分配」里的「生图」行、供应商模型行上的「图片」标记、素材库开关。
 * 生图没有独立的供应商配置：直接复用「第三方供应商」（同一份列表 / Key / 地址 / 启用开关），
 * 图片模型按打包的 model_specs 规则自动识别，也可以在供应商的模型行上手动标记。
 */
import { Icon, Select, Switch, t } from '@nomi-ai/ui';
import { ImagePlus } from 'lucide-react';
import React from 'react';

import {
  choiceProviders,
  displayName,
  modelForProvider,
  modelName,
  providerModelIds,
  mediaClient,
  mediaToast,
  describeChange,
  useMediaState,
  type ChoiceChange,
  type MediaState,
} from '../../services/mediaClient';

import styles from './Media.module.css';

function report(state: MediaState | null, changes: ChoiceChange[] | undefined): void {
  for (const c of changes ?? []) mediaToast(describeChange(state, c));
}

async function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    mediaToast((e as Error).message || t('ui.media.action-failed'));
    return undefined;
  }
}

export interface MediaAssignRowProps {
  rowClassName?: string;
  labelClassName?: string;
}

/** 「按任务分配」→「生图」 */
export const MediaAssignRow: React.FC<MediaAssignRowProps> = ({ rowClassName, labelClassName }) => {
  const [state, refresh] = useMediaState();
  if (!mediaClient.available() || !state) return null;
  const cur = state.prefs.chatDefaultImage;
  const providerRef = cur?.providerRef ?? '';
  // 先选供应商（已启用 + 有 Key + 有可用模型），再选它提供的模型
  const providerOptions = [
    {
      value: '',
      label: t('ui.providers-schedule.not-configured-plain'),
      // 没有可生图的供应商：引导到下方「第三方供应商」里添加 / 标记图片模型
      ...(choiceProviders(state).length ? {} : { description: t('ui.media.no-image-provider') }),
    },
    ...choiceProviders(state).map((p) => ({
      value: p.id,
      label: displayName(p.name),
      description: t('ui.media.provider-models', providerModelIds(state, p.id).length),
    })),
  ];
  const modelOptions = providerModelIds(state, providerRef).map((id) => ({
    value: id,
    label: modelName(state, id),
  }));
  const setDefault = async (choice: { modelId: string; providerRef: string } | null) => {
    await guarded(() => mediaClient.setChatDefault(choice));
    refresh();
  };
  return (
    <div className={rowClassName} data-testid="assign-image">
      <span className={labelClassName} title={t('ui.media.provider-first')}>
        {t('ui.media.assign-label')}
      </span>
      <div className={styles.assignPickers}>
        <Select
          size="sm"
          value={providerRef}
          options={providerOptions}
          aria-label={t('ui.media.choose-provider')}
          data-testid="assign-image-provider"
          onChange={(e) => {
            const ref = e.target.value;
            if (!ref) return void setDefault(null);
            const modelId = modelForProvider(state, ref, cur?.modelId ?? '');
            if (modelId) void setDefault({ modelId, providerRef: ref });
          }}
        />
        <Select
          size="sm"
          value={cur?.modelId ?? ''}
          options={modelOptions}
          placeholder={t('ui.media.assign-model')}
          disabled={!providerRef || !modelOptions.length}
          aria-label={t('ui.media.assign-model')}
          data-testid="assign-image-model"
          onChange={(e) =>
            e.target.value && void setDefault({ modelId: e.target.value, providerRef })
          }
        />
      </div>
    </div>
  );
};

/** 供应商模型行上的生图标记：自动识别 / 标为某个图片模型 / 不是图片模型 */
export interface MediaImageMarkProps {
  /** 由供应商详情统一取一次（useMediaState），避免每行各自请求 */
  state: MediaState;
  providerId: string;
  upstream: string;
  onDone: () => void;
}

const AUTO = '__auto';
const NOT_IMAGE = '__none';

export const MediaImageMark: React.FC<MediaImageMarkProps> = ({
  state,
  providerId,
  upstream,
  onDone,
}) => {
  const mark = state.marks.find((m) => m.providerRef === providerId && m.upstream === upstream);
  const bound = state.bindings.find(
    (b) => b.providerRef === providerId && b.upstreamModelName === upstream,
  );
  const value = !mark ? AUTO : mark.modelId === null ? NOT_IMAGE : mark.modelId;
  const autoLabel = bound
    ? t('ui.media.mark-auto-detected', modelName(state, bound.modelId))
    : t('ui.media.mark-auto');
  const options = [
    { value: AUTO, label: autoLabel },
    ...state.models.map((m) => ({ value: m.id, label: modelName(state, m.id) })),
    { value: NOT_IMAGE, label: t('ui.media.mark-not-image') },
  ];
  const onChange = async (v: string) => {
    const modelId = v === AUTO ? undefined : v === NOT_IMAGE ? null : v;
    const r = await guarded(() =>
      mediaClient.markImage({ providerRef: providerId, upstream, modelId }),
    );
    report(state, r?.changes);
    onDone();
  };
  return (
    <span className={styles.imageMark} data-testid="media-image-mark">
      {bound && (
        <span className={styles.imageBadge} title={modelName(state, bound.modelId)}>
          <Icon icon={ImagePlus} size={12} />
          {t('ui.providers-schedule.image')}
        </span>
      )}
      <Select
        size="sm"
        value={value}
        options={options}
        aria-label={t('ui.media.mark-label')}
        onChange={(e) => void onChange(e.target.value)}
      />
    </span>
  );
};

export interface MediaPrefsCardProps {
  className?: string;
  titleClassName?: string;
}

/** 生图素材库开关（供应商在上方「第三方供应商」里配置） */
export const MediaPrefsCard: React.FC<MediaPrefsCardProps> = ({ className, titleClassName }) => {
  const [state, refresh] = useMediaState();
  if (!mediaClient.available() || !state) return null;
  const setPref = (p: { autoAddGenerated?: boolean; autoAddUploads?: boolean }) =>
    void guarded(() => mediaClient.setPrefs(p)).then(refresh);
  return (
    <section className={className} aria-labelledby="models-media" data-testid="models-media">
      <h3 id="models-media" className={titleClassName}>
        <Icon icon={ImagePlus} size={16} />
        {t('ui.media.prefs-title')}
      </h3>
      <p className={styles.muted}>{t('ui.media.reuse-providers')}</p>
      {state.localOnly && <p className={styles.warn}>{t('ui.media.local-only-warning')}</p>}
      <div className={styles.prefRow}>
        <Switch
          checked={state.prefs.autoAddGenerated}
          onChange={(v) => setPref({ autoAddGenerated: v })}
          label={t('ui.media.auto-add-generated')}
          data-testid="pref-auto-add-generated"
        />
      </div>
      <div className={styles.prefRow}>
        <Switch
          checked={state.prefs.autoAddUploads}
          onChange={(v) => setPref({ autoAddUploads: v })}
          label={t('ui.media.auto-add-uploads')}
          data-testid="pref-auto-add-uploads"
        />
      </div>
    </section>
  );
};
