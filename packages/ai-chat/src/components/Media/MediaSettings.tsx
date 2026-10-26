/**
 * 设置 → 模型：「按任务分配」里的「生图」行 + 生图供应商卡片（Key 只写不读）+ 两个入库开关。
 * 先选模型，再选能提供它的（已启用且已填 Key 的）供应商；初始未配置。
 */
import type { MediaProtocol } from '@nomi-ai/gateway/media';
import { Button, Icon, Input, Select, Switch, t } from '@nomi-ai/ui';
import { ChevronDown, ChevronRight, ImagePlus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import {
  displayName,
  mediaClient,
  mediaToast,
  describeChange,
  useMediaState,
  type ChoiceChange,
  type MediaProviderView,
  type MediaState,
} from '../../services/mediaClient';

import styles from './Media.module.css';

const PROTOCOLS: MediaProtocol[] = [
  'openai-images',
  'gemini',
  'ark-image',
  'openrouter-chat-image',
  'fal',
];

function usableProviders(s: MediaState, modelId: string): MediaProviderView[] {
  return s.bindings
    .filter((b) => b.modelId === modelId && b.enabled)
    .map((b) => s.providers.find((p) => p.id === b.providerRef))
    .filter((p): p is MediaProviderView => !!p && p.enabled && p.hasKey);
}

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
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  if (!mediaClient.available() || !state) return null;
  const cur = state.prefs.chatDefaultImage;
  const modelId = pendingModel ?? cur?.modelId ?? '';
  const providers = modelId ? usableProviders(state, modelId) : [];
  const modelOptions = [
    { value: '', label: t('ui.providers-schedule.not-configured-plain') },
    ...state.models.map((m) => ({
      value: m.id,
      label: m.name,
      description: usableProviders(state, m.id).length
        ? undefined
        : t('ui.media.no-usable-provider'),
    })),
  ];
  const providerOptions = providers.map((p) => ({ value: p.id, label: displayName(p.name) }));
  const setDefault = async (choice: { modelId: string; providerRef: string } | null) => {
    await guarded(() => mediaClient.setChatDefault(choice));
    setPendingModel(null);
    refresh();
  };
  return (
    <div className={rowClassName} data-testid="assign-image">
      <span className={labelClassName}>{t('ui.media.assign-label')}</span>
      <div className={styles.assignPickers}>
        <Select
          size="sm"
          value={modelId}
          options={modelOptions}
          aria-label={t('ui.media.assign-model')}
          data-testid="assign-image-model"
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return void setDefault(null);
            const ps = usableProviders(state, v);
            if (ps.length === 1) return void setDefault({ modelId: v, providerRef: ps[0]!.id });
            setPendingModel(v);
          }}
        />
        <Select
          size="sm"
          value={pendingModel ? '' : (cur?.providerRef ?? '')}
          options={providerOptions}
          placeholder={
            modelId && !providers.length
              ? t('ui.media.configure-provider-below')
              : t('ui.media.choose-provider')
          }
          disabled={!modelId || !providers.length}
          aria-label={t('ui.media.choose-provider')}
          data-testid="assign-image-provider"
          onChange={(e) =>
            e.target.value && void setDefault({ modelId, providerRef: e.target.value })
          }
        />
      </div>
    </div>
  );
};

const ProviderRow: React.FC<{ state: MediaState; p: MediaProviderView; onDone: () => void }> = ({
  state,
  p,
  onDone,
}) => {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [bind, setBind] = useState<{ modelId: string; presetKey: MediaProtocol; upstream: string }>(
    {
      modelId: state.models[0]?.id ?? '',
      presetKey: 'openai-images',
      upstream: '',
    },
  );
  const bindings = state.bindings.filter((b) => b.providerRef === p.id);
  const upsert = async (patch: Parameters<typeof mediaClient.upsertProvider>[0]) => {
    const r = await guarded(() => mediaClient.upsertProvider({ id: p.id, ...patch }));
    report(state, r?.changes);
    onDone();
  };
  return (
    <div className={styles.provider} data-testid={`media-provider-${p.id}`}>
      <div className={styles.providerHead}>
        <button
          type="button"
          className={styles.expand}
          onClick={() => setOpen((x) => !x)}
          aria-expanded={open}
        >
          <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
          <span className={styles.providerName}>{displayName(p.name)}</span>
        </button>
        <span className={styles.keyState}>
          {p.hasKey ? `${t('ui.media.key-set')} ${p.keyHint ?? ''}` : t('ui.media.key-missing')}
        </span>
        <Switch
          checked={p.enabled}
          onChange={(v) => void upsert({ enabled: v })}
          aria-label={t('ui.media.provider-enabled')}
        />
      </div>
      {open && (
        <div className={styles.providerBody}>
          <div className={styles.muted}>{p.baseURL}</div>
          <div className={styles.inline}>
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              value={key}
              placeholder={
                p.hasKey ? t('ui.media.key-replace') : t('ui.voice-mascot.paste-your-api-key')
              }
              onChange={(e) => setKey(e.target.value)}
              aria-label={t('ui.media.api-key')}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!key.trim()}
              onClick={() => void upsert({ apiKey: key.trim() }).then(() => setKey(''))}
            >
              {t('ui.foundation.save')}
            </Button>
            {p.hasKey && (
              <Button size="sm" variant="ghost" onClick={() => void upsert({ apiKey: null })}>
                {t('ui.media.clear-key')}
              </Button>
            )}
            {p.custom && (
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  void guarded(() => mediaClient.removeProvider(p.id)).then((r) => {
                    report(state, r?.changes);
                    onDone();
                  })
                }
                aria-label={t('ui.models.delete-provider')}
              >
                <Icon icon={Trash2} size={14} />
              </Button>
            )}
          </div>
          <div className={styles.bindings}>
            {bindings.map((b) => (
              <div key={b.modelId} className={styles.binding}>
                <span className={styles.bindingName}>
                  {state.models.find((m) => m.id === b.modelId)?.name ?? b.modelId}
                </span>
                <Input
                  size="sm"
                  defaultValue={b.upstreamModelName}
                  aria-label={t('ui.models.upstream-model')}
                  title={t('ui.models.upstream-model')}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== b.upstreamModelName)
                      void guarded(() =>
                        mediaClient.upsertBinding({ ...b, upstreamModelName: v }),
                      ).then(onDone);
                  }}
                />
                <Switch
                  checked={b.enabled}
                  onChange={(v) =>
                    void guarded(() => mediaClient.upsertBinding({ ...b, enabled: v })).then(
                      (r) => {
                        report(state, r?.changes);
                        onDone();
                      },
                    )
                  }
                  aria-label={t('ui.media.binding-enabled')}
                />
                {p.custom && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('ui.media.remove-binding')}
                    onClick={() =>
                      void guarded(() =>
                        mediaClient.removeBinding({ modelId: b.modelId, providerRef: p.id }),
                      ).then((r) => {
                        report(state, r?.changes);
                        onDone();
                      })
                    }
                  >
                    <Icon icon={Trash2} size={14} />
                  </Button>
                )}
              </div>
            ))}
            {p.custom && (
              <div className={styles.binding}>
                <Select
                  size="sm"
                  value={bind.modelId}
                  options={state.models.map((m) => ({ value: m.id, label: m.name }))}
                  onChange={(e) => setBind({ ...bind, modelId: e.target.value })}
                  aria-label={t('ui.media.assign-model')}
                />
                <Select
                  size="sm"
                  value={bind.presetKey}
                  options={PROTOCOLS.map((x) => ({ value: x, label: x }))}
                  onChange={(e) => setBind({ ...bind, presetKey: e.target.value as MediaProtocol })}
                  aria-label={t('ui.media.protocol')}
                />
                <Input
                  size="sm"
                  value={bind.upstream}
                  placeholder={t('ui.models.upstream-model')}
                  onChange={(e) => setBind({ ...bind, upstream: e.target.value })}
                />
                <Button
                  size="sm"
                  disabled={!bind.modelId || !bind.upstream.trim()}
                  onClick={() =>
                    void guarded(() =>
                      mediaClient.upsertBinding({
                        providerRef: p.id,
                        modelId: bind.modelId,
                        enabled: true,
                        presetKey: bind.presetKey,
                        upstreamModelName: bind.upstream.trim(),
                      }),
                    ).then(() => {
                      setBind({ ...bind, upstream: '' });
                      onDone();
                    })
                  }
                >
                  {t('ui.media.add-binding')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export interface MediaProvidersCardProps {
  className?: string;
  titleClassName?: string;
}

/** 生图供应商 + 入库开关 */
export const MediaProvidersCard: React.FC<MediaProvidersCardProps> = ({
  className,
  titleClassName,
}) => {
  const [state, refresh] = useMediaState();
  const [draft, setDraft] = useState({ name: '', baseURL: '', apiKey: '' });
  if (!mediaClient.available() || !state) return null;
  const setPref = (p: { autoAddGenerated?: boolean; autoAddUploads?: boolean }) =>
    void guarded(() => mediaClient.setPrefs(p)).then(refresh);
  return (
    <section className={className} aria-labelledby="models-media" data-testid="models-media">
      <h3 id="models-media" className={titleClassName}>
        <Icon icon={ImagePlus} size={16} />
        {t('ui.media.providers-title')}
      </h3>
      <p className={styles.muted}>{t('ui.media.providers-sub')}</p>
      {state.localOnly && <p className={styles.warn}>{t('ui.media.local-only-warning')}</p>}
      {state.providers.map((p) => (
        <ProviderRow key={p.id} state={state} p={p} onDone={refresh} />
      ))}
      <div className={styles.inline}>
        <Input
          size="sm"
          value={draft.name}
          placeholder={t('ui.media.custom-name')}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <Input
          size="sm"
          value={draft.baseURL}
          placeholder="https://"
          onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
          aria-label={t('ui.media.base-url')}
        />
        <Input
          size="sm"
          type="password"
          autoComplete="off"
          value={draft.apiKey}
          placeholder={t('ui.media.api-key')}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
        />
        <Button
          size="sm"
          disabled={!draft.name.trim() || !draft.baseURL.trim()}
          onClick={() =>
            void guarded(() =>
              mediaClient.upsertProvider({
                name: draft.name.trim(),
                baseURL: draft.baseURL.trim(),
                enabled: true,
                ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
              }),
            ).then((r) => {
              if (r) setDraft({ name: '', baseURL: '', apiKey: '' });
              refresh();
            })
          }
        >
          {t('ui.media.add-custom')}
        </Button>
      </div>
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
