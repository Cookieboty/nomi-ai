/**
 * 知识库回答的引用：正文里的 [n] 由 citeRefs.tsx 在 Markdown 中变成可点击的上标；底部列出来源卡片。
 * 点击来源 → 预览片段，可「打开文件」或「在文件夹中显示」（主进程重新检查授权）；笔记直接显示全文。
 */
import { t, Icon } from '@nomi-ai/ui';
import { Button, Modal } from '@nomi-ai/ui';
import { BookOpen } from 'lucide-react';
import React, { useState } from 'react';
import { createPortal } from 'react-dom';

import { kbClient, shortPath, type KbSource } from '../../services/kbClient';

import styles from './Citations.module.css';

export const SourceList: React.FC<{ sources: KbSource[]; onPick: (s: KbSource) => void }> = ({
  sources,
  onPick,
}) => (
  <div className={styles.sources} data-testid="kb-sources-list">
    <span className={styles.sourcesLabel}>
      <Icon icon={BookOpen} size={14} />
      {t('ui.providers-schedule.sources')}
    </span>
    {sources.map((s) => (
      <button
        key={s.chunkId}
        type="button"
        className={styles.sourceChip}
        onClick={() => onPick(s)}
        title={s.path}
        data-testid="kb-source-chip"
      >
        <span className={styles.sourceNum}>{s.n}</span>
        <span className={styles.sourceTitle}>{t(s.title)}</span>
        {s.page ? (
          <span className={styles.sourceMeta}>
            {t('ui.providers-schedule.p')} {s.page} {t('ui.providers-schedule.message')}
          </span>
        ) : null}
      </button>
    ))}
  </div>
);

export const SourcePreview: React.FC<{ source: KbSource | null; onClose: () => void }> = ({
  source,
  onClose,
}) => {
  const [err, setErr] = useState('');
  if (!source) return null;
  const act = async (how: 'open' | 'reveal') => {
    setErr('');
    try {
      const r = await kbClient.open(source.docId, how);
      if (!r.ok) setErr(r.error ?? t('ui.foundation.couldn-t-open'));
      else onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const close = () => {
    setErr('');
    onClose();
  };
  // 挂到 body：消息气泡的 backdrop-filter 会让 fixed 定位的弹层错位
  return createPortal(
    <Modal
      open
      onClose={close}
      title={`[${source.n}] ${source.title}`}
      data-testid="kb-source-preview"
      footer={
        <>
          <Button onClick={() => void act('reveal')}>
            {t('ui.providers-schedule.show-in-folder')}
          </Button>
          <Button variant="primary" onClick={() => void act('open')} data-testid="kb-open-file">
            {t('ui.providers-schedule.open-file')}
          </Button>
        </>
      }
    >
      <div className={styles.previewBody}>
        <div className={styles.previewPath}>
          {shortPath(source.path)}
          {source.page ? t('ui.knowledge-local.page', source.page) : ''}
        </div>
        <blockquote className={styles.previewQuote}>{source.snippet}</blockquote>
        {err && <div className={styles.errorText}>{err}</div>}
      </div>
    </Modal>,
    document.body,
  );
};
