/**
 * 工作台主区（自上而下）：顶栏 → Hero 横幅（推荐词）→ 进行中任务卡（估算进度）+ 生成队列
 * → 结果大图卡 → 输入框（提示词 / 参考图 / 发送 + 只读参数摘要，点击跳到右侧设置）。
 */
import { Icon, IconButton, t } from '@nomi-ai/ui';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  Download,
  FolderPlus,
  ImagePlus,
  Maximize2,
  AlertCircle,
  Clock,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import {
  mediaClient,
  mediaToast,
  modelName,
  providerName,
  type MediaTask,
} from '../../services/mediaClient';

import type { StudioCtx } from './ImageStudio';
import { MediaImageMenu } from './MediaImageMenu';
import styles from './Studio.module.css';
import { label } from './StudioControls';
import {
  estimateProgress,
  EXPECTED_MS,
  queueView,
  STAGE_I18N,
  SUGGESTIONS,
  UPLOAD_TYPES,
} from './studioModel';

const fail = (e: Error) => mediaToast(e.message || t('ui.media.action-failed'));

const TopBar: React.FC<{ ctx: StudioCtx }> = ({ ctx }) => (
  <header className={styles.topBar}>
    <div className={styles.topLeft}>
      {ctx.onBack && (
        <IconButton
          label={t('ui.media.nav-studio')}
          onClick={ctx.onBack}
          variant="ghost"
          icon={<Icon icon={ArrowLeft} size={18} />}
        />
      )}
      <h2 className={styles.title}>{t('ui.media.nav-studio')}</h2>
    </div>
    <div className={styles.topRight}>
      {ctx.draft && (
        <button type="button" className={styles.linkBtn} onClick={ctx.restore}>
          {t('ui.media.restore-draft')}
        </button>
      )}
      <button
        type="button"
        className={styles.outlineBtn}
        onClick={ctx.save}
        data-testid="studio-save-draft"
      >
        {t('ui.media.save-draft')}
      </button>
      <button
        type="button"
        className={styles.primaryBtn}
        disabled={!ctx.canGenerate}
        onClick={ctx.generate}
        data-testid="studio-generate"
      >
        <Icon icon={Sparkles} size={15} />
        {t('ui.media.generate')}
      </button>
    </div>
  </header>
);

const Hero: React.FC<{ ctx: StudioCtx }> = ({ ctx }) => (
  <div className={styles.hero}>
    <div className={styles.heroText}>
      <span className={styles.heroTag}>
        <Icon icon={Sparkles} size={13} />
        {t('ui.media.studio-hero-tag')}
      </span>
      <h1 className={styles.heroTitle}>{t('ui.media.studio-hero-title')}</h1>
      <p className={styles.heroSub}>{t('ui.media.studio-hero-sub')}</p>
      <div className={styles.suggestions}>
        {SUGGESTIONS.map((k) => (
          <button
            key={k.label}
            type="button"
            className={styles.suggestion}
            onClick={() => ctx.setPrompt(t(k.prompt))}
          >
            {t(k.label)}
          </button>
        ))}
      </div>
    </div>
    <img className={styles.heroArt} src="./brand/studio/hero.webp" alt="" draggable={false} />
  </div>
);

const ProgressCard: React.FC<{ ctx: StudioCtx; task: MediaTask; others: number }> = ({
  ctx,
  task,
  others,
}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  const p = estimateProgress(task, now);
  const preview = ctx.library.find((a) => ctx.refs.includes(a.id))?.url;
  return (
    <div className={styles.card} data-testid="studio-progress">
      <div className={styles.progressBody}>
        <div className={styles.progressHead}>
          <span className={styles.progressIcon}>
            <Icon icon={Sparkles} size={20} />
          </span>
          <div className={styles.progressInfo}>
            <div className={styles.cardTitle}>{t('ui.media.generating')}</div>
            <div className={styles.muted}>
              {task.status === 'queued'
                ? t('ui.media.progress-queued')
                : t('ui.media.progress-desc', p.elapsedSec, Math.round(EXPECTED_MS / 1000))}
              {others > 0 && ` · ${t('ui.media.more-running', others)}`}
            </div>
          </div>
        </div>
        <div className={styles.barRow}>
          <div className={styles.bar} aria-hidden>
            <div className={styles.barFill} style={{ width: `${p.percent}%` }} />
          </div>
          <span className={styles.barPct}>≈{p.percent}%</span>
        </div>
        <ol className={styles.steps}>
          {STAGE_I18N.map((s, i) => {
            const st = i < p.stage ? 'done' : i === p.stage ? 'active' : 'todo';
            return (
              <li key={s} className={styles.step} data-state={st}>
                <span className={styles.stepDot}>
                  {st === 'done' ? <Icon icon={Check} size={11} /> : i + 1}
                </span>
                <span>{t(s)}</span>
              </li>
            );
          })}
        </ol>
      </div>
      <div className={styles.progressPreview}>
        <img src={preview ?? `./brand/studio/style-${ctx.style}.webp`} alt="" />
        <span className={styles.shimmer} />
      </div>
    </div>
  );
};

const ResultCard: React.FC<{ ctx: StudioCtx; task: MediaTask }> = ({ ctx, task }) => {
  const [sel, setSel] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [more, setMore] = useState(false);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const asset = task.assets[Math.min(sel, task.assets.length - 1)];
  if (!asset) return null;
  const inLib = asset.inLibrary || saved[asset.id];
  return (
    <div className={`${styles.card} ${styles.resultCard}`} data-testid="studio-result">
      <div className={styles.resultMain}>
        <MediaImageMenu src={asset.url} source="studio">
          <img src={asset.url} alt={task.prompt} className={styles.resultImg} />
        </MediaImageMenu>
        <span className={styles.cornerTag}>{modelName(ctx.state, task.modelId)}</span>
        <span className={styles.doneBadge}>
          <Icon icon={Check} size={13} />
          {t('ui.media.result-done')}
        </span>
      </div>
      {task.assets.length > 1 && (
        <div className={styles.thumbs} data-testid="studio-gallery">
          {task.assets.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className={`${styles.thumb} ${i === sel ? styles.thumbOn : ''}`}
              onClick={() => setSel(i)}
              aria-pressed={i === sel}
            >
              <img src={a.url} alt="" />
            </button>
          ))}
        </div>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.actionBtn} onClick={() => ctx.retry(task)}>
          <Icon icon={RotateCcw} size={15} />
          {t('ui.usage-tools.regenerate')}
        </button>
        <button type="button" className={styles.actionBtn} onClick={() => setZoom(true)}>
          <Icon icon={Maximize2} size={15} />
          {t('ui.usage-tools.zoom-in')}
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => void mediaClient.saveImage(asset.url, `nomi-${asset.id}`).catch(fail)}
        >
          <Icon icon={Download} size={15} />
          {t('ui.knowledge-local.download')}
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          disabled={inLib}
          onClick={() =>
            void mediaClient
              .setInLibrary(asset.id, true)
              .then(() => {
                setSaved((s) => ({ ...s, [asset.id]: true }));
                mediaToast(t('ui.media.added-to-library'));
              })
              .catch(fail)
          }
        >
          <Icon icon={FolderPlus} size={15} />
          {inLib ? t('ui.media.in-library') : t('ui.media.save-to-library')}
        </button>
        <div className={styles.menuWrap}>
          <button
            type="button"
            className={styles.actionBtn}
            aria-expanded={more}
            onClick={() => setMore((m) => !m)}
          >
            <Icon icon={MoreHorizontal} size={15} />
            {t('ui.voice-mascot.more')}
          </button>
          {more && (
            <div className={`${styles.menuList} ${styles.menuUp} ${styles.menuRight}`}>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  setMore(false);
                  void mediaClient
                    .copyImage(asset.url)
                    .then(() => mediaToast(t('ui.media.copied')))
                    .catch(fail);
                }}
              >
                <Icon icon={Copy} size={14} />
                {t('ui.media.copy-image')}
              </button>
              <button
                type="button"
                className={styles.menuItem}
                disabled={ctx.maxRefs === 0}
                onClick={() => {
                  setMore(false);
                  if (!ctx.refs.includes(asset.id)) ctx.toggleRef(asset.id);
                }}
              >
                <Icon icon={ImagePlus} size={14} />
                {t('ui.media.use-as-ref')}
              </button>
            </div>
          )}
        </div>
      </div>
      {zoom && (
        <div className={styles.lightbox} role="dialog" onClick={() => setZoom(false)}>
          <img src={asset.url} alt={task.prompt} />
          <IconButton
            label={t('ui.knowledge-local.collapse')}
            className={styles.lightboxClose}
            icon={<Icon icon={X} size={18} />}
          />
        </div>
      )}
    </div>
  );
};

const useNow = (on: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
};

/** 生成队列：生成中 / 排队中 / 最近完成与失败；排队可取消、失败可重试、完成可查看 */
const QueueCard: React.FC<{ ctx: StudioCtx; items: MediaTask[]; shown: string | undefined }> = ({
  ctx,
  items,
  shown,
}) => {
  const now = useNow(items.some((x) => x.status === 'running'));
  const status = (x: MediaTask) => {
    if (x.status === 'queued') return t('ui.mascot-theme.queued');
    if (x.status === 'running') {
      const pr =
        x.progress && x.progress.total > 1
          ? `${x.progress.done}/${x.progress.total}`
          : `≈${estimateProgress(x, now).percent}%`;
      return t('ui.media.queue-running', pr);
    }
    if (x.status === 'succeeded') return t('ui.foundation.done');
    return x.error?.code === 'canceled'
      ? t('electron.common.cancelled')
      : t('ui.foundation.failed');
  };
  return (
    <div className={`${styles.card} ${styles.queueCard}`} data-testid="studio-queue-main">
      <div className={styles.queueHead}>
        <span className={styles.cardTitle}>{t('ui.media.queue-title')}</span>
        <span className={styles.muted}>
          {items.filter((x) => x.status === 'running' || x.status === 'queued').length}
        </span>
      </div>
      <ul className={styles.queueList}>
        {items.map((x) => (
          <li
            key={x.id}
            className={`${styles.queueRow} ${x.id === shown ? styles.queueOn : ''}`}
            data-status={x.status}
          >
            <button
              type="button"
              className={styles.queueMain}
              disabled={x.status !== 'succeeded'}
              onClick={() => ctx.setFocusTaskId(x.id)}
              title={x.status === 'failed' ? (x.error?.message ?? x.prompt) : x.prompt}
            >
              <span className={styles.queueIcon}>
                <Icon
                  icon={
                    x.status === 'running'
                      ? Loader2
                      : x.status === 'queued'
                        ? Clock
                        : x.status === 'succeeded'
                          ? Check
                          : AlertCircle
                  }
                  size={13}
                />
              </span>
              <span className={styles.queueText}>
                <span className={styles.queuePrompt}>{x.prompt}</span>
                <span className={styles.queueMeta}>
                  {providerName(ctx.state, x.providerRef)} · {modelName(ctx.state, x.modelId)} ·{' '}
                  {t(
                    'ui.media.image-count',
                    x.status === 'succeeded' ? x.assets.length : Number(x.params.n ?? 1),
                  )}
                </span>
              </span>
              <span className={styles.queueStatus}>{status(x)}</span>
            </button>
            {(x.status === 'queued' || x.status === 'running') && (
              <IconButton
                size="sm"
                variant="ghost"
                label={t('ui.foundation.cancel')}
                onClick={() => ctx.cancel(x)}
                data-testid="studio-queue-cancel"
                icon={<Icon icon={X} size={13} />}
              />
            )}
            {x.status === 'failed' && (
              <IconButton
                size="sm"
                variant="ghost"
                label={t('ui.mascot-theme.retry')}
                onClick={() => ctx.retry(x)}
                data-testid="studio-queue-retry"
                icon={<Icon icon={RotateCcw} size={13} />}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

/** 输入框：只有提示词、快速加参考图、发送；参数只读摘要，点击跳到右侧对应设置并高亮 */
const Composer: React.FC<{ ctx: StudioCtx }> = ({ ctx }) => {
  const file = useRef<HTMLInputElement>(null);
  const fields = [...(ctx.layout?.basic ?? []), ...(ctx.layout?.advanced ?? [])];
  const ratio = fields.find((f) => f.key === 'aspect_ratio');
  const count = fields.find((f) => f.key === 'n');
  const summary: Array<{ key: string; text: string }> = [
    ...(ctx.providerRef
      ? [{ key: 'provider', text: providerName(ctx.state, ctx.providerRef) }]
      : []),
    ...(ctx.modelId ? [{ key: 'model', text: modelName(ctx.state, ctx.modelId) }] : []),
    ...(ratio && ctx.params.aspect_ratio !== undefined
      ? [
          {
            key: 'aspect_ratio',
            text: label(
              ratio['x-ui'].optionLabels?.[String(ctx.params.aspect_ratio)] ??
                String(ctx.params.aspect_ratio),
            ),
          },
        ]
      : []),
    ...(count ? [{ key: 'n', text: t('ui.media.image-count', Number(ctx.params.n ?? 1)) }] : []),
  ];
  return (
    <div className={styles.composer}>
      <textarea
        className={styles.composerInput}
        value={ctx.prompt}
        rows={2}
        placeholder={t('ui.media.studio-placeholder')}
        onChange={(e) => ctx.setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ctx.generate();
        }}
        data-testid="studio-prompt"
      />
      <div className={styles.composerBar}>
        <div className={styles.composerTools}>
          <IconButton
            variant="ghost"
            label={t('ui.media.add-ref')}
            disabled={ctx.maxRefs === 0 || ctx.refs.length >= ctx.maxRefs}
            onClick={() => file.current?.click()}
            data-testid="studio-add-ref"
            icon={<Icon icon={ImagePlus} size={16} />}
          />
          <input
            ref={file}
            type="file"
            accept={UPLOAD_TYPES.join(',')}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) ctx.upload(f);
              e.target.value = '';
            }}
          />
          <div className={styles.summary} data-testid="studio-summary">
            {summary.map((x, i) => (
              <React.Fragment key={x.key}>
                {i > 0 && <span className={styles.summaryDot}>·</span>}
                <button
                  type="button"
                  className={styles.summaryItem}
                  title={t('ui.media.edit-in-panel')}
                  onClick={() => ctx.focusSetting(x.key)}
                >
                  {x.text}
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={styles.sendBtn}
          aria-label={t('ui.media.generate')}
          disabled={!ctx.canGenerate}
          onClick={ctx.generate}
          data-testid="studio-send"
        >
          <Icon icon={ArrowUp} size={18} />
        </button>
      </div>
    </div>
  );
};

export const StudioMain: React.FC<{ ctx: StudioCtx }> = ({ ctx }) => {
  const running = ctx.tasks.filter((x) => x.status === 'running' || x.status === 'queued');
  const done = ctx.tasks.filter((x) => x.status === 'succeeded' && x.assets.length);
  const result = done.find((x) => x.id === ctx.focusTaskId) ?? done[0];
  const queue = queueView(ctx.tasks);
  const current = running.find((x) => x.status === 'running') ?? running[0];
  return (
    <div className={styles.main}>
      <TopBar ctx={ctx} />
      <div className={styles.mainScroll}>
        {ctx.state.localOnly && <p className={styles.warn}>{t('ui.media.local-only-warning')}</p>}
        <Hero ctx={ctx} />
        {current && (
          <div className={styles.progressRow}>
            <ProgressCard ctx={ctx} task={current} others={running.length - 1} />
            {queue.length > 1 && <QueueCard ctx={ctx} items={queue} shown={result?.id} />}
          </div>
        )}
        {result ? (
          <ResultCard key={result.id} ctx={ctx} task={result} />
        ) : (
          !running.length && <p className={styles.emptyHint}>{t('ui.media.studio-empty')}</p>
        )}
      </div>
      <Composer ctx={ctx} />
    </div>
  );
};
