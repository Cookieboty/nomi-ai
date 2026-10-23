/** 文件编辑的 diff 视图：文件名 + 增删统计 + 行着色；未改行折叠（Codex 风格） */
import { t } from '@nomi-ai/ui';
import React, { useMemo, useState } from 'react';

import type { DiffLine } from '../../utils/lineDiff';
import type { FileDiff } from '../../utils/toolTrace';
import { workspaceRelPath } from '../../utils/workspacePath';

import styles from './Tool.module.css';

const MAX_LINES = 400;
const CTX_FOLD_MIN = 6;
const SIGN = { add: '+', del: '-', ctx: ' ', hunk: '' } as const;

type Row =
  | { kind: 'line'; line: DiffLine; key: string }
  | { kind: 'fold'; count: number; key: string; lines: DiffLine[] };

function buildRows(lines: DiffLine[]): Row[] {
  const out: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.type === 'hunk') {
      const m = /^(\d+)\s+unmodified lines$/.exec(L.text.trim());
      if (m) {
        out.push({ kind: 'fold', count: Number(m[1]), key: `h-${i}`, lines: [] });
      } else if (L.text === '…' || L.text.trim() === '…') {
        out.push({ kind: 'fold', count: 0, key: `h-${i}`, lines: [] });
      } else {
        out.push({ kind: 'line', line: L, key: `l-${i}` });
      }
      i += 1;
      continue;
    }
    if (L.type === 'ctx') {
      let j = i;
      while (j < lines.length && lines[j]!.type === 'ctx') j += 1;
      const run = lines.slice(i, j);
      if (run.length >= CTX_FOLD_MIN) {
        out.push({ kind: 'fold', count: run.length, key: `c-${i}`, lines: run });
      } else {
        for (let k = 0; k < run.length; k++) {
          out.push({ kind: 'line', line: run[k]!, key: `l-${i + k}` });
        }
      }
      i = j;
      continue;
    }
    out.push({ kind: 'line', line: L, key: `l-${i}` });
    i += 1;
  }
  return out;
}

export const DiffView: React.FC<{
  diff: FileDiff;
  /** 给了工作目录时文件名显示为相对路径（完整路径放 tooltip） */
  cwd?: string | null;
  /** 独立面板里铺满高度、不在块内再滚动（对话里仍限高） */
  fill?: boolean;
}> = ({ diff, cwd, fill = false }) => {
  const { lines, added, removed } = diff.diff;
  const shown = useMemo(() => lines.slice(0, MAX_LINES), [lines]);
  const rows = useMemo(() => buildRows(shown), [shown]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  return (
    <div className={styles.diff} data-fill={fill || undefined} data-testid="tool-diff">
      <div className={styles.diffHead}>
        <span className={styles.diffFile} title={diff.file}>
          {diff.file ? workspaceRelPath(cwd, diff.file) : t('（未命名文件）')}
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
          {rows.map((r) => {
            if (r.kind === 'fold') {
              const expanded = open[r.key];
              if (expanded && r.lines.length) {
                return (
                  <React.Fragment key={r.key}>
                    {r.lines.map((l, idx) => (
                      <div
                        key={`${r.key}-${idx}`}
                        className={styles.diffLine}
                        data-type={l.type}
                        role="row"
                      >
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
                    <button
                      type="button"
                      className={styles.diffFold}
                      data-testid="diff-fold"
                      onClick={() => setOpen((s) => ({ ...s, [r.key]: false }))}
                    >
                      {t('收起未修改行')}
                    </button>
                  </React.Fragment>
                );
              }
              const label = r.count > 0 ? t('{0} 行未修改', r.count) : t('未修改行已折叠');
              return (
                <button
                  key={r.key}
                  type="button"
                  className={styles.diffFold}
                  data-testid="diff-fold"
                  data-count={r.count || undefined}
                  onClick={() => {
                    if (r.lines.length) setOpen((s) => ({ ...s, [r.key]: true }));
                  }}
                >
                  {label}
                </button>
              );
            }
            const l = r.line;
            return (
              <div key={r.key} className={styles.diffLine} data-type={l.type} role="row">
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
            );
          })}
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
