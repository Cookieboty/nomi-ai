/**
 * 文件编辑的 diff 视图：文件名 + 增删统计 + 行着色；未改行折叠（Codex 风格）。
 * 独立面板（split="auto"）够宽时左右并排：左旧右新，删除 / 新增成对对齐。
 */
import { t } from '@nomi-ai/ui';
import { Columns2, Rows2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { DiffLine } from '../../utils/lineDiff';
import type { FileDiff } from '../../utils/toolTrace';
import { workspaceRelPath } from '../../utils/workspacePath';

import styles from './Tool.module.css';

const MAX_LINES = 400;
const CTX_FOLD_MIN = 6;
const SIGN = { add: '+', del: '-', ctx: ' ', hunk: '' } as const;
/** 容器宽度到这里才左右并排（两侧各约 60 列代码） */
export const SPLIT_MIN_WIDTH = 900;
const LAYOUT_KEY = 'nomi.diffLayout';

type Row =
  | { kind: 'line'; line: DiffLine; key: string }
  | { kind: 'fold'; count: number; key: string; lines: DiffLine[] };

/** 并排的一行：两侧各一条（缺的一侧留空）；hunk 头横跨两侧 */
export type SplitPair =
  { kind: 'pair'; left?: DiffLine; right?: DiffLine } | { kind: 'hunk'; line: DiffLine };

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

/** 连续的删除段与紧随的新增段按序配对；未改行两侧都显示 */
export function pairSplitLines(lines: readonly DiffLine[]): SplitPair[] {
  const out: SplitPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.type === 'hunk') {
      out.push({ kind: 'hunk', line: L });
      i += 1;
    } else if (L.type === 'ctx') {
      out.push({ kind: 'pair', left: L, right: L });
      i += 1;
    } else {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i]!.type === 'del') dels.push(lines[i++]!);
      while (i < lines.length && lines[i]!.type === 'add') adds.push(lines[i++]!);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        out.push({ kind: 'pair', left: dels[k], right: adds[k] });
      }
    }
  }
  return out;
}

type LayoutPref = 'auto' | 'unified';

function readLayoutPref(): LayoutPref {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'unified' ? 'unified' : 'auto';
  } catch {
    return 'auto';
  }
}

/** 并排 / 单列偏好全局共用：一块里切换，同屏其它 Diff 一起变 */
let layoutPref: LayoutPref | null = null;
const layoutSubs = new Set<() => void>();
const getLayoutPref = (): LayoutPref => (layoutPref ??= readLayoutPref());
const subscribeLayoutPref = (fn: () => void) => {
  layoutSubs.add(fn);
  return () => layoutSubs.delete(fn);
};
function setLayoutPref(next: LayoutPref): void {
  layoutPref = next;
  try {
    localStorage.setItem(LAYOUT_KEY, next);
  } catch {
    /* ignore */
  }
  layoutSubs.forEach((fn) => fn());
}

/** 容器宽度（不支持 ResizeObserver 的环境返回 0，即不并排） */
function useWidth(ref: React.RefObject<HTMLElement | null>, enabled: boolean): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(e?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return w;
}

const UnifiedLine: React.FC<{ l: DiffLine }> = ({ l }) => (
  <div className={styles.diffLine} data-type={l.type} role="row">
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

const SplitSide: React.FC<{ l?: DiffLine; side: 'old' | 'new' }> = ({ l, side }) =>
  l ? (
    <div className={styles.splitSide} data-type={l.type} role="cell">
      <span className={styles.diffNo} aria-hidden>
        {(side === 'old' ? l.oldNo : l.newNo) ?? ''}
      </span>
      <span className={styles.diffSign} aria-hidden>
        {SIGN[l.type]}
      </span>
      <span className={styles.diffText}>{l.text || ' '}</span>
    </div>
  ) : (
    <div className={styles.splitSide} data-empty role="cell" />
  );

const SplitLines: React.FC<{ lines: readonly DiffLine[] }> = ({ lines }) => (
  <>
    {pairSplitLines(lines).map((p, i) =>
      p.kind === 'hunk' ? (
        <div key={i} className={styles.diffLine} data-type="hunk" role="row">
          <span className={styles.diffText}>{p.line.text}</span>
        </div>
      ) : (
        <div key={i} className={styles.splitRow} role="row" data-testid="diff-split-row">
          <SplitSide l={p.left} side="old" />
          <SplitSide l={p.right} side="new" />
        </div>
      ),
    )}
  </>
);

export const DiffView: React.FC<{
  diff: FileDiff;
  /** 给了工作目录时文件名显示为相对路径（完整路径放 tooltip） */
  cwd?: string | null;
  /** 独立面板里铺满高度、不在块内再滚动（对话里仍限高） */
  fill?: boolean;
  /** 'auto'：容器够宽时左右并排（可在头部切回单列，全局记住） */
  split?: 'auto' | false;
}> = ({ diff, cwd, fill = false, split = false }) => {
  const { lines, added, removed } = diff.diff;
  const shown = useMemo(() => lines.slice(0, MAX_LINES), [lines]);
  const rows = useMemo(() => buildRows(shown), [shown]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef, split === 'auto');
  const pref = useSyncExternalStore(subscribeLayoutPref, getLayoutPref, () => 'auto' as const);
  const wide = split === 'auto' && width >= SPLIT_MIN_WIDTH;
  const sideBySide = wide && pref === 'auto';

  const togglePref = () => setLayoutPref(pref === 'auto' ? 'unified' : 'auto');

  // 按折叠块切段：段内是连续的行，并排时整段配对
  const segments = useMemo(() => {
    const out: Array<{ kind: 'lines'; key: string; lines: DiffLine[] } | Row> = [];
    let buf: DiffLine[] = [];
    let bufKey = '';
    const flush = () => {
      if (buf.length) out.push({ kind: 'lines', key: bufKey, lines: buf });
      buf = [];
    };
    for (const r of rows) {
      if (r.kind === 'line') {
        if (!buf.length) bufKey = r.key;
        buf.push(r.line);
      } else {
        flush();
        out.push(r);
      }
    }
    flush();
    return out;
  }, [rows]);

  const renderLines = (ls: readonly DiffLine[]) =>
    sideBySide ? <SplitLines lines={ls} /> : ls.map((l, i) => <UnifiedLine key={i} l={l} />);

  return (
    <div
      ref={rootRef}
      className={styles.diff}
      data-fill={fill || undefined}
      data-layout={sideBySide ? 'split' : 'unified'}
      data-testid="tool-diff"
    >
      <div className={styles.diffHead}>
        <span className={styles.diffFile} title={diff.file}>
          {diff.file ? workspaceRelPath(cwd, diff.file) : t('ui.usage-tools.unnamed-file')}
        </span>
        {diff.changeKind && <span className={styles.diffKind}>{diff.changeKind}</span>}
        {!diff.summaryOnly && (
          <span className={styles.diffStat}>
            <span className={styles.add}>+{added}</span>
            <span className={styles.del}>−{removed}</span>
          </span>
        )}
        {wide && shown.length > 0 ? (
          <button
            type="button"
            className={styles.diffLayoutBtn}
            data-testid="diff-layout-toggle"
            aria-pressed={sideBySide}
            title={
              sideBySide
                ? t('ui.session-workspace.switch-to-unified-view')
                : t('ui.session-workspace.switch-to-side-by-side-view')
            }
            aria-label={
              sideBySide
                ? t('ui.session-workspace.switch-to-unified-view')
                : t('ui.session-workspace.switch-to-side-by-side-view')
            }
            onClick={togglePref}
          >
            {sideBySide ? <Rows2 size={14} /> : <Columns2 size={14} />}
          </button>
        ) : null}
      </div>
      {shown.length > 0 && (
        <div className={styles.diffBody} role="table" aria-label={t('ui.usage-tools.file-diff')}>
          {segments.map((s) => {
            if (s.kind === 'lines') {
              return <React.Fragment key={s.key}>{renderLines(s.lines)}</React.Fragment>;
            }
            if (s.kind !== 'fold') return null;
            if (open[s.key] && s.lines.length) {
              return (
                <React.Fragment key={s.key}>
                  {renderLines(s.lines)}
                  <button
                    type="button"
                    className={styles.diffFold}
                    data-testid="diff-fold"
                    onClick={() => setOpen((o) => ({ ...o, [s.key]: false }))}
                  >
                    {t('ui.usage-tools.collapse-unmodified-lines')}
                  </button>
                </React.Fragment>
              );
            }
            const label =
              s.count > 0
                ? t('ui.usage-tools.unmodified-lines', s.count)
                : t('ui.usage-tools.unmodified-lines-folded');
            return (
              <button
                key={s.key}
                type="button"
                className={styles.diffFold}
                data-testid="diff-fold"
                data-count={s.count || undefined}
                onClick={() => {
                  if (s.lines.length) setOpen((o) => ({ ...o, [s.key]: true }));
                }}
              >
                {label}
              </button>
            );
          })}
          {lines.length > MAX_LINES && (
            <div className={styles.diffMore}>
              {t('ui.usage-tools.more-lines-not-shown', lines.length - MAX_LINES)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
