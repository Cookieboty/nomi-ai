/**
 * 图片工作台（整页，侧栏固定入口打开）。本文件只管状态与动作：
 * 主区（顶栏 / Hero / 进行中任务 + 生成队列 / 结果大图 / 输入框）见 StudioMain，右侧「生成设置」见 StudioSettings。
 * 参数只在右侧编辑（唯一入口）；输入框下方只读摘要，点击跳到右侧对应项并高亮。
 * 先选供应商，再选它提供的模型。队列在主进程（每个供应商并发上限见 PROVIDER_CONCURRENCY）。
 * 参数控件全部按当前模型 schema 渲染；记住上次选择（studioLast，主进程在成功后写入）；
 * 任务异步，结果经 ai:media:task 推送。
 */
import {
  clampOnChange,
  initialParams,
  layoutProperties,
  migrateParams,
  type LayoutResult,
  type MediaModelSpec,
  type MediaParams,
  type ParamValue,
} from '@nomi-ai/gateway/media';
import { t } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useState } from 'react';

import {
  choiceProviders,
  mediaClient,
  mediaToast,
  modelForProvider,
  openMedia,
  useMediaState,
  type MediaAsset,
  type MediaState,
  type MediaTask,
} from '../../services/mediaClient';

import styles from './Studio.module.css';
import { StudioMain } from './StudioMain';
import {
  applyStyle,
  hasStyleParam,
  loadDraft,
  saveDraft,
  STYLE_I18N,
  uploadAllowed,
  type StudioDraft,
  type StyleKey,
} from './studioModel';
import { StudioSettings } from './StudioSettings';

export function usable(s: MediaState, modelId: string) {
  return s.bindings
    .filter((b) => b.modelId === modelId && b.enabled)
    .map((b) => s.providers.find((p) => p.id === b.providerRef))
    .filter((p): p is NonNullable<typeof p> => !!p && p.enabled && p.hasKey);
}

const storage = () => (typeof window !== 'undefined' ? window.localStorage : null);

export interface StudioCtx {
  state: MediaState;
  spec: MediaModelSpec | undefined;
  layout: LayoutResult | null;
  modelId: string;
  providerRef: string;
  params: MediaParams;
  prompt: string;
  style: StyleKey;
  refs: string[];
  maxRefs: number;
  library: MediaAsset[];
  tasks: MediaTask[];
  advOpen: boolean;
  draft: StudioDraft | null;
  focusTaskId: string | null;
  /** 输入框摘要点击后高亮的右侧设置项（provider / model / 参数 key） */
  highlight: string | null;
  setPrompt: (p: string) => void;
  setStyle: (s: StyleKey) => void;
  pickProvider: (p: string) => void;
  focusSetting: (key: string) => void;
  cancel: (task: MediaTask) => void;
  setAdvOpen: (v: boolean) => void;
  setFocusTaskId: (id: string | null) => void;
  pickModel: (id: string) => void;
  change: (key: string, v: ParamValue | undefined) => void;
  resetParams: () => void;
  toggleRef: (id: string) => void;
  upload: (file: File) => void;
  generate: () => void;
  retry: (task: MediaTask) => void;
  save: () => void;
  restore: () => void;
  canGenerate: boolean;
  onBack?: () => void;
}

export const ImageStudio: React.FC<{ active: boolean; prompt?: string; onBack?: () => void }> = ({
  active,
  prompt: initialPrompt,
  onBack,
}) => {
  const open = active;
  const [state] = useMediaState();
  const [modelId, setModelId] = useState('');
  const [providerRef, setProviderRef] = useState('');
  const [params, setParams] = useState<MediaParams>({});
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<StyleKey>('general');
  const [refs, setRefs] = useState<string[]>([]);
  const [library, setLibrary] = useState<MediaAsset[]>([]);
  const [tasks, setTasks] = useState<MediaTask[]>([]);
  const [inited, setInited] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [draft, setDraft] = useState<StudioDraft | null>(null);
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (!highlight) return;
    const id = window.setTimeout(() => setHighlight(null), 1600);
    return () => window.clearTimeout(id);
  }, [highlight]);

  // 初始：上次的选择（参数按当前 schema 迁移），否则第一个有可用供应商的模型
  useEffect(() => {
    if (!open || !state || inited) return;
    const last = state.prefs.studioLast;
    const spec =
      (last && state.models.find((m) => m.id === last.modelId)) ||
      state.models.find(
        (m) => m.id === modelForProvider(state, choiceProviders(state)[0]?.id ?? '', ''),
      ) ||
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
    const s = storage();
    if (s) setDraft(loadDraft(s));
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
    const offTask = mediaClient.onTask((task) => {
      if (task.surface !== 'studio') return;
      setTasks((prev) => [task, ...prev.filter((x) => x.id !== task.id)]);
      if (task.status === 'succeeded') setFocusTaskId(null);
      if (task.status === 'failed' && task.error && task.error.code !== 'canceled')
        mediaToast(task.error.message);
    });
    const offChanged = mediaClient.onChanged(() => {
      void mediaClient
        .assets()
        .then(setLibrary)
        .catch(() => undefined);
    });
    return () => {
      offTask();
      offChanged();
    };
  }, [open]);

  const spec = state?.models.find((m) => m.id === modelId);
  const layout = useMemo(
    () => (spec ? layoutProperties(spec, params, 'studio') : null),
    [spec, params],
  );
  if (!state) return null;
  const maxRefs = spec?.['x-media']?.image?.max ?? 0;

  const pickModel = (id: string, keep?: MediaParams, via?: string) => {
    const to = state.models.find((m) => m.id === id);
    if (!to) return;
    setModelId(id);
    const ps = usable(state, id);
    const ref = via ?? providerRef;
    // 当前供应商也提供该模型就不换供应商
    setProviderRef(ps.some((p) => p.id === ref) ? ref : (ps[0]?.id ?? ''));
    setParams(migrateParams(to, keep ?? params, state.prefs.userDefaults[id]).params);
    setRefs((r) => r.slice(0, to['x-media']?.image?.max ?? 0));
  };

  const submit = async (req: Parameters<typeof mediaClient.start>[0]) => {
    try {
      const task = await mediaClient.start(req);
      setTasks((prev) => [task, ...prev.filter((x) => x.id !== task.id)]);
    } catch (e) {
      mediaToast((e as Error).message || t('ui.media.action-failed'));
    }
  };
  // 当前 schema 没有风格参数 → 风格作为提示词模板追加（通用不追加）
  const stylePrompt = STYLE_I18N[style].prompt;
  const finalPrompt = () =>
    spec && !hasStyleParam(spec.paramsSchema.properties) && stylePrompt
      ? applyStyle(prompt, t(stylePrompt))
      : prompt.trim();
  const canGenerate = !!modelId && !!providerRef && !!prompt.trim();

  const ctx: StudioCtx = {
    state,
    spec,
    layout,
    modelId,
    providerRef,
    params,
    prompt,
    style,
    refs,
    maxRefs,
    library,
    tasks,
    advOpen,
    draft,
    focusTaskId,
    setPrompt,
    setStyle,
    highlight,
    pickProvider: (ref) => {
      const next = modelForProvider(state, ref, modelId);
      if (next && next !== modelId) pickModel(next, undefined, ref);
      else setProviderRef(ref);
    },
    focusSetting: (key) => {
      if (spec && layout?.advanced.some((f) => f.key === key)) setAdvOpen(true);
      setHighlight(key);
      window.requestAnimationFrame(() =>
        document
          .querySelector(`[data-setting="${key}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      );
    },
    cancel: (task) => void mediaClient.cancel(task.id).catch((e: Error) => mediaToast(e.message)),
    setAdvOpen,
    setFocusTaskId,
    pickModel: (id) => pickModel(id),
    change: (key, v) => spec && setParams(clampOnChange(spec, params, key, v).params),
    resetParams: () => spec && setParams(initialParams(spec, state.prefs.userDefaults[spec.id])),
    toggleRef: (id) =>
      setRefs((r) =>
        r.includes(id) ? r.filter((x) => x !== id) : r.length < maxRefs ? [...r, id] : r,
      ),
    upload: (file) => {
      if (!uploadAllowed(file)) return mediaToast(t('ui.media.ref-too-large'));
      const reader = new FileReader();
      reader.onload = () => {
        // 上传的参考图经 addAsset 进入本机素材库（manual_add），再作为参考图引用
        void mediaClient
          .addAsset(String(reader.result), 'manual_add')
          .then((a) => {
            setLibrary((l) => [a, ...l.filter((x) => x.id !== a.id)]);
            setRefs((r) => (r.includes(a.id) || r.length >= maxRefs ? r : [...r, a.id]));
          })
          .catch((e: Error) => mediaToast(e.message || t('ui.media.action-failed')));
      };
      reader.readAsDataURL(file);
    },
    generate: () => {
      if (!canGenerate) return;
      void submit({
        modelId,
        providerRef,
        prompt: finalPrompt(),
        params,
        refs: refs.map((assetId) => ({ assetId })),
      });
    },
    // 失败的任务交给主进程按原请求（含参考图）重新排队；其余按快照再跑一次
    retry: (task) =>
      task.status === 'failed'
        ? void mediaClient
            .retry(task.id)
            .then((n) => setTasks((prev) => [n, ...prev.filter((x) => x.id !== n.id)]))
            .catch((e: Error) => mediaToast(e.message || t('ui.media.action-failed')))
        : void submit({
            modelId: task.modelId,
            providerRef: task.providerRef,
            prompt: task.prompt,
            params: task.params,
          }),
    save: () => {
      const s = storage();
      if (!s) return;
      saveDraft(s, { modelId, providerRef, prompt, params, style });
      setDraft(loadDraft(s));
      mediaToast(t('ui.media.draft-saved'));
    },
    restore: () => {
      if (!draft) return;
      if (state.models.some((m) => m.id === draft.modelId)) {
        pickModel(draft.modelId, draft.params);
        if (usable(state, draft.modelId).some((p) => p.id === draft.providerRef))
          setProviderRef(draft.providerRef);
      }
      setPrompt(draft.prompt);
      setStyle(draft.style);
      mediaToast(t('ui.media.draft-restored'));
    },
    canGenerate,
    onBack,
  };

  return (
    <section
      className={styles.page}
      data-testid="image-studio"
      aria-label={t('ui.media.nav-studio')}
    >
      <StudioMain ctx={ctx} />
      <StudioSettings ctx={ctx} />
    </section>
  );
};

export const openLibrary = () => openMedia({ target: 'library' });
