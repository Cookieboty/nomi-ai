/**
 * 工作台右侧「生成设置」：模型（先选模型）→ 供应商 → schema 基础参数 → 风格 → 高级参数（折叠）
 * → 参考图（上传 / 素材库）→ 历史记录。所有参数字段与取值来自当前模型 schema。
 */
import { Icon, IconButton, t } from '@nomi-ai/ui';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ImageUp,
  Plug,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import React, { useRef, useState } from 'react';

import { displayName, modelName, openMedia, type MediaTask } from '../../services/mediaClient';

import { usable, type StudioCtx } from './ImageStudio';
import styles from './Studio.module.css';
import { IconMenu, StudioField, label, type MenuItem } from './StudioControls';
import { CAP_I18N, STYLE_I18N, STYLE_KEYS, UPLOAD_TYPES } from './studioModel';

/** 模型下拉项：名称 + 「默认」徽标（对话默认模型）+ 按能力生成的一行说明 */
export function modelItems(ctx: StudioCtx): MenuItem[] {
  const def = ctx.state.prefs.chatDefaultImage?.modelId;
  return ctx.state.models.map((m) => ({
    value: m.id,
    title: m.name,
    badge: m.id === def ? t('ui.providers-schedule.default') : undefined,
    description: usable(ctx.state, m.id).length
      ? m.capabilities.flatMap((c) => (CAP_I18N[c] ? [t(CAP_I18N[c])] : [])).join(' · ')
      : t('ui.media.no-usable-provider'),
  }));
}

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const History: React.FC<{ ctx: StudioCtx }> = ({ ctx }) => {
  const items = ctx.tasks.filter((x) => x.status === 'succeeded' || x.status === 'failed');
  const meta = (x: MediaTask) =>
    t(
      'ui.media.history-meta',
      modelName(ctx.state, x.modelId),
      String(x.params.aspect_ratio ?? '—'),
      x.status === 'succeeded' ? x.assets.length : Number(x.params.n ?? 1),
    );
  return (
    <section className={styles.sideSection}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>{t('ui.media.history')}</span>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => openMedia({ target: 'library' })}
        >
          {t('ui.providers-schedule.all')}
          <Icon icon={ChevronRight} size={13} />
        </button>
      </div>
      {!items.length && <p className={styles.muted}>{t('ui.media.history-empty')}</p>}
      <div className={styles.history} data-testid="studio-queue">
        {items.slice(0, 20).map((x) => (
          <div
            key={x.id}
            className={`${styles.historyItem} ${x.id === ctx.focusTaskId ? styles.historyOn : ''}`}
            data-status={x.status}
          >
            <button
              type="button"
              className={styles.historyMain}
              disabled={x.status !== 'succeeded'}
              onClick={() => ctx.setFocusTaskId(x.id)}
            >
              {x.assets[0] ? (
                <img src={x.assets[0].url} alt="" className={styles.historyThumb} />
              ) : (
                <span className={`${styles.historyThumb} ${styles.historyFail}`}>
                  <Icon icon={AlertCircle} size={16} />
                </span>
              )}
              <span className={styles.historyText}>
                <span className={styles.historyPrompt} title={x.prompt}>
                  {x.prompt}
                </span>
                <span className={styles.historyMeta}>
                  {x.status === 'failed'
                    ? (x.error?.message ?? t('ui.foundation.failed'))
                    : meta(x)}
                </span>
              </span>
              <span className={styles.historyTime}>{time(x.finishedAt ?? x.createdAt)}</span>
            </button>
            {x.status === 'failed' && (
              <IconButton
                size="sm"
                variant="ghost"
                label={t('ui.media.retry-snapshot')}
                onClick={() => ctx.retry(x)}
                data-testid="studio-retry"
                icon={<Icon icon={RotateCcw} size={13} />}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
};

const Refs: React.FC<{ ctx: StudioCtx }> = ({ ctx }) => {
  const input = useRef<HTMLInputElement>(null);
  const [pick, setPick] = useState(false);
  const chosen = ctx.library.filter((a) => ctx.refs.includes(a.id));
  const title = label(ctx.spec?.['x-media']?.image?.label ?? 'ui.media.ref-image');
  if (ctx.maxRefs === 0)
    return (
      <section className={styles.sideSection}>
        <span className={styles.sectionTitle}>{t('ui.media.ref-optional')}</span>
        <p className={styles.muted}>{t('ui.media.ref-unsupported')}</p>
      </section>
    );
  return (
    <section className={styles.sideSection}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>
          {t('ui.media.ref-optional')}
          <span className={styles.count}>
            {title} {ctx.refs.length}/{ctx.maxRefs}
          </span>
        </span>
        {ctx.library.length > 0 && (
          <button type="button" className={styles.linkBtn} onClick={() => setPick((p) => !p)}>
            {t('ui.media.ref-from-library')}
          </button>
        )}
      </div>
      {chosen.length > 0 && (
        <div className={styles.refRow}>
          {chosen.map((a) => (
            <span key={a.id} className={styles.refChosen}>
              <img src={a.url} alt="" />
              <button
                type="button"
                aria-label={t('ui.media.ref-remove')}
                onClick={() => ctx.toggleRef(a.id)}
              >
                <Icon icon={X} size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <button
        type="button"
        className={styles.dropZone}
        disabled={ctx.refs.length >= ctx.maxRefs}
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) ctx.upload(f);
        }}
      >
        <Icon icon={ImageUp} size={22} />
        <span>{t('ui.media.ref-upload-hint')}</span>
        <span className={styles.dropHint}>{t('ui.media.ref-upload-limit')}</span>
      </button>
      <input
        ref={input}
        type="file"
        accept={UPLOAD_TYPES.join(',')}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) ctx.upload(f);
          e.target.value = '';
        }}
      />
      {pick && (
        <div className={styles.refPicker}>
          {ctx.library.slice(0, 24).map((a) => {
            const on = ctx.refs.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                className={`${styles.refThumb} ${on ? styles.refOn : ''}`}
                aria-pressed={on}
                disabled={!on && ctx.refs.length >= ctx.maxRefs}
                onClick={() => ctx.toggleRef(a.id)}
              >
                <img src={a.url} alt="" />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
};

export const StudioSettings: React.FC<{ ctx: StudioCtx }> = ({ ctx }) => {
  const providers = ctx.modelId ? usable(ctx.state, ctx.modelId) : [];
  const field = (f: NonNullable<StudioCtx['layout']>['basic'][number]) => (
    <StudioField
      key={f.key}
      f={f}
      value={ctx.params[f.key]}
      onChange={(v) => ctx.change(f.key, v)}
    />
  );
  return (
    <aside className={styles.side} data-testid="studio-params">
      <div className={styles.sideCard}>
        <h3 className={styles.sideTitle}>{t('ui.media.settings-title')}</h3>
        <section className={styles.sideSection}>
          <span className={styles.sectionTitle}>{t('ui.media.model-select')}</span>
          <IconMenu
            items={modelItems(ctx)}
            value={ctx.modelId}
            onChange={ctx.pickModel}
            icon={<Icon icon={Sparkles} size={18} />}
            ariaLabel={t('ui.media.assign-model')}
            testId="studio-model"
          />
          <IconMenu
            items={providers.map((p) => ({
              value: p.id,
              title: displayName(p.name),
              description: t('ui.media.via-provider', displayName(p.name)),
            }))}
            value={ctx.providerRef}
            onChange={ctx.setProviderRef}
            icon={<Icon icon={Plug} size={16} />}
            ariaLabel={t('ui.media.choose-provider')}
            placeholder={
              providers.length
                ? t('ui.media.choose-provider')
                : t('ui.media.configure-provider-in-settings')
            }
            disabled={!providers.length}
            testId="studio-provider"
          />
        </section>
        <section className={styles.sideSection}>{ctx.layout?.basic.map(field)}</section>
        <section className={styles.sideSection}>
          <span className={styles.sectionTitle}>{t('ui.media.style-title')}</span>
          <div className={styles.styles} role="radiogroup" aria-label={t('ui.media.style-title')}>
            {STYLE_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={ctx.style === k}
                className={`${styles.styleCard} ${ctx.style === k ? styles.styleOn : ''}`}
                onClick={() => ctx.setStyle(k)}
              >
                <img src={`./brand/studio/style-${k}.webp`} alt="" />
                <span>{t(STYLE_I18N[k].label)}</span>
              </button>
            ))}
          </div>
        </section>
        {!!ctx.layout?.advanced.length && (
          <section className={styles.sideSection} data-testid="studio-advanced">
            <button
              type="button"
              className={styles.advHead}
              aria-expanded={ctx.advOpen}
              onClick={() => ctx.setAdvOpen(!ctx.advOpen)}
            >
              <span className={styles.sectionTitle}>{t('ui.media.advanced')}</span>
              <Icon icon={ctx.advOpen ? ChevronDown : ChevronRight} size={15} />
            </button>
            {ctx.advOpen && <div className={styles.advBody}>{ctx.layout.advanced.map(field)}</div>}
          </section>
        )}
        <Refs ctx={ctx} />
        <History ctx={ctx} />
      </div>
    </aside>
  );
};
