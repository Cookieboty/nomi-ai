/** 文件编辑的 diff 视图：文件名 + 增删统计 + 行着色（只读） */
import { t } from '@nomi-ai/ui';
import React from 'react';

import type { FileDiff } from '../../utils/toolTrace';

import styles from './Tool.module.css';

const MAX_LINES = 400;
const SIGN = { add: '+', del: '-', ctx: ' ', hunk: '' } as const;

export const DiffView: React.FC<{ diff: FileDiff }> = ({ diff }) => {
  const { lines, added, removed } = diff.diff;
  const shown = lines.slice(0, MAX_LINES);
  return (
    <div className={styles.diff} data-testid="tool-diff">
      <div className={styles.diffHead}>
        <span className={styles.diffFile} title={diff.file}>
          {diff.file || t('（未命名文件）')}
        </span>
        {diff.changeKind && <span className={styles.diffKind}>{diff.changeKind}</span>}
        {!diff.summaryOnly && (
          <span className={styles.diffStat}>
            <span className={styles.add}>+{added}</span>
            <span className={styles.del}>−{removed}</span>
          </span>
        )}
      </div>
      {shown.length > 0 && (
        <div className={styles.diffBody} role="table" aria-label={t('文件差异')}>
          {shown.map((l, i) => (
            <div key={i} className={styles.diffLine} data-type={l.type} role="row">
              <span className={styles.diffNo} aria-hidden>
                {l.oldNo ?? ''}
              </span>
              <span className={styles.diffNo} aria-hidden>
                {l.newNo ?? ''}
              </span>
              <span className={styles.diffSign} aria-hidden>
                {SIGN[l.type]}
              </span>
              <span className={styles.diffText}>{l.text || ' '}</span>
            </div>
          ))}
          {lines.length > MAX_LINES && (
            <div className={styles.diffMore}>
              {t('还有 {0} 行未显示', lines.length - MAX_LINES)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
