/**
 * 知识库回答的引用：正文里的 [n] 变成可点击的上标；底部列出来源卡片。
 * 点击来源 → 预览片段，可「打开文件」或「在文件夹中显示」（主进程重新检查授权）；笔记直接显示全文。
 */
import { t, Icon } from '@nomi-ai/ui';
import { Button, Modal } from '@nomi-ai/ui';
import { BookOpen } from 'lucide-react';
import React, { useState } from 'react';
import { createPortal } from 'react-dom';

import { kbClient, shortPath, type KbSource } from '../../services/kbClient';

import styles from './Citations.module.css';

/** 把 "…[1][2]…" 拆成文本与引用编号（纯函数，便于测试） */
export function splitCitations(text: string, valid: Set<number>): Array<string | number> {
  const out: Array<string | number> = [];
  let last = 0;
  for (const m of text.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (!valid.has(n)) continue;
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(n);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const CitedText: React.FC<{
  text: string;
  sources: KbSource[];
  onPick: (s: KbSource) => void;
}> = ({ text, sources, onPick }) => {
  const byN = new Map(sources.map((s) => [s.n, s]));
  return (
    <>
      {splitCitations(text, new Set(byN.keys())).map((p, i) =>
        typeof p === 'string' ? (
          <React.Fragment key={i}>{p}</React.Fragment>
        ) : (
          <button
            key={i}
            type="button"
            className={styles.cite}
            onClick={() => onPick(byN.get(p)!)}
            title={t(byN.get(p)!.title)}
            data-testid="kb-cite"
          >
            {p}
          </button>
        ),
      )}
    </>
  );
};

export const SourceList: React.FC<{ sources: KbSource[]; onPick: (s: KbSource) => void }> = ({
  sources,
  onPick,
}) => (
  <div className={styles.sources} data-testid="kb-sources-list">
    <span className={styles.sourcesLabel}>
      <Icon icon={BookOpen} size={14} />
      {t('出处')}
    </span>
    {sources.map((s) => (
      <button
        key={s.chunkId}
        type="button"
        className={styles.sourceChip}
        onClick={() => onPick(s)}
        title={s.path.startsWith('note:') ? s.title : s.path}
        data-testid="kb-source-chip"
      >
        <span className={styles.sourceNum}>{s.n}</span>
        <span className={styles.sourceTitle}>{t(s.title)}</span>
        {s.page ? (
          <span className={styles.sourceMeta}>
            {t('第')} {s.page} {t('页')}
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
  const [note, setNote] = useState<{ title: string; body: string } | null>(null);
  const [err, setErr] = useState('');
  if (!source) return null;
  const isNote = source.path.startsWith('note:');
  const act = async (how: 'open' | 'reveal' | 'preview') => {
    setErr('');
    try {
      const r = await kbClient.open(source.docId, how);
      if (!r.ok) setErr(r.error ?? t('打开失败'));
      else if (r.note) setNote(r.note);
      else onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const close = () => {
    setNote(null);
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
        isNote ? (
          <Button variant="primary" onClick={() => void act('preview')} disabled={!!note}>
            {t('查看全文')}
          </Button>
        ) : (
          <>
            <Button onClick={() => void act('reveal')}>{t('在文件夹中显示')}</Button>
            <Button variant="primary" onClick={() => void act('open')} data-testid="kb-open-file">
              {t('打开文件')}
            </Button>
          </>
        )
      }
    >
      <div className={styles.previewBody}>
        <div className={styles.previewPath}>
          {isNote ? t('本地笔记') : shortPath(source.path)}
          {source.page ? t(' · 第 {0} 页', source.page) : ''}
        </div>
        <blockquote className={styles.previewQuote}>{note ? note.body : source.snippet}</blockquote>
        {err && <div className={styles.errorText}>{err}</div>}
      </div>
    </Modal>,
    document.body,
  );
};
