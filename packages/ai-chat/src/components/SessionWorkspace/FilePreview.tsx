/**
 * 多文件预览：Tab / 面包屑、切文件保留滚动与选区、←→ 切文件、
 * 磁盘内容可编辑保存（cwd 沙箱）、可选丢弃本轮 diff。
 */
import { t } from '@nomi-ai/ui';
import { ChevronLeft, ChevronRight, Eye, FileCode2, RotateCcw, Save, X } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { harnessClient } from '../../services/harnessClient';
import { reconstructOldText } from '../../utils/diffReconstruct';
import type { ChangeEntry } from '../../utils/sessionChanges';
import type { FileDiff } from '../../utils/toolTrace';
import { workspaceRelPath } from '../../utils/workspacePath';
import { DiffView } from '../Conversation/DiffView';
import { Markdown } from '../Conversation/Markdown';

import styles from './SessionWorkspace.module.css';

/** diff；file = 编辑磁盘内容；render = Markdown 渲染预览（只对 .md） */
export type PreviewMode = 'diff' | 'file' | 'render';

const isMarkdownPath = (p: string) => /\.(md|markdown|mdx)$/i.test(p);

export interface PreviewFile {
  key: string;
  path: string;
  letter?: string;
  added?: number;
  removed?: number;
  /** 本轮 tool diff（可丢弃） */
  change?: ChangeEntry;
  /** git unified body → DiffView */
  gitDiff?: FileDiff;
}

interface FileViewState {
  scrollTop: number;
  selStart: number;
  selEnd: number;
  draft?: string;
  dirty?: boolean;
}

export const FilePreview: React.FC<{
  files: PreviewFile[];
  activeKey: string;
  cwd?: string | null;
  onActiveKey: (key: string) => void;
  onClose: () => void;
  onSaved?: () => void;
  /** 旁边已有文件列表（右栏）时不再显示文件标签条 */
  hideFileTabs?: boolean;
}> = ({ files, activeKey, cwd, onActiveKey, onClose, onSaved, hideFileTabs = false }) => {
  const [mode, setMode] = useState<PreviewMode>('diff');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [disk, setDisk] = useState<string>('');
  const [binary, setBinary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirtyTick, setDirtyTick] = useState(0);
  const viewState = useRef<Map<string, FileViewState>>(new Map());
  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const idx = Math.max(
    0,
    files.findIndex((f) => f.key === activeKey),
  );
  const active = files[idx] ?? files[0];

  // 换文件时：有 diff 先看 Diff，没有就直接编辑。只看文件和有没有 diff，
  // 列表刷新（窗口重新聚焦会刷新 git）不打断正在编辑 / 预览的文件
  const activeHasDiff = !!(active?.change?.diff || active?.gitDiff);
  useEffect(() => {
    setMode(activeHasDiff ? 'diff' : 'file');
  }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps -- 只在换文件时重置

  const crumbs = useMemo(() => {
    const p = active?.path ?? '';
    return p.split(/[/\\]/).filter(Boolean);
  }, [active?.path]);

  const persistView = useCallback(() => {
    if (!active) return;
    const prev = viewState.current.get(active.key) ?? {
      scrollTop: 0,
      selStart: 0,
      selEnd: 0,
    };
    if (mode === 'file' && taRef.current) {
      prev.scrollTop = taRef.current.scrollTop;
      prev.selStart = taRef.current.selectionStart;
      prev.selEnd = taRef.current.selectionEnd;
      prev.draft = taRef.current.value;
      prev.dirty = taRef.current.value !== disk;
    } else if (bodyRef.current) {
      prev.scrollTop = bodyRef.current.scrollTop;
    }
    viewState.current.set(active.key, prev);
  }, [active, disk, mode]);

  const go = useCallback(
    (delta: number) => {
      if (!files.length) return;
      persistView();
      const next = (idx + delta + files.length) % files.length;
      onActiveKey(files[next]!.key);
    },
    [files, idx, onActiveKey, persistView],
  );

  const pendingRestore = useRef<{ key: string; content: string } | null>(null);
  useLayoutEffect(() => {
    const p = pendingRestore.current;
    const ta = taRef.current;
    if (!p || !ta || p.key !== active?.key) return;
    pendingRestore.current = null;
    ta.value = p.content;
    const st = viewState.current.get(p.key);
    if (st) {
      ta.scrollTop = st.scrollTop;
      try {
        ta.setSelectionRange(st.selStart, st.selEnd);
      } catch {
        /* ignore */
      }
    }
  });
  const activeFileKey = active?.key;
  const activePath = active?.path;
  const loadDisk = useCallback(async () => {
    if (!cwd || !activeFileKey || !activePath) {
      setDisk('');
      setBinary(false);
      setErr(cwd ? null : t('当前会话没有工作目录'));
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await harnessClient.workspaceRead(cwd, workspaceRelPath(cwd, activePath));
      if (!r.ok) {
        setDisk('');
        setBinary(false);
        setErr(
          r.code === 'outside'
            ? t('路径不在工作区内，已拒绝读取')
            : r.code === 'not-found'
              ? t('文件不存在（可能尚未写入磁盘）')
              : r.error || t('读取失败'),
        );
        return;
      }
      if (r.binary) {
        setBinary(true);
        setDisk('');
        return;
      }
      setBinary(false);
      const cached = viewState.current.get(activeFileKey);
      const content = cached?.dirty && cached.draft != null ? cached.draft : (r.content ?? '');
      setDisk(r.content ?? '');
      // 读取期间编辑框被卸载：等它重新渲染出来再写回草稿与滚动 / 选区（见下方 layout effect）
      pendingRestore.current = { key: activeFileKey, content };
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeFileKey, activePath, cwd]);

  useEffect(() => {
    if (mode === 'file' || mode === 'render') void loadDisk();
    else {
      requestAnimationFrame(() => {
        const el = bodyRef.current;
        const st = active ? viewState.current.get(active.key) : undefined;
        if (el && st) el.scrollTop = st.scrollTop;
      });
    }
  }, [active?.key, mode, loadDisk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === '[') {
        e.preventDefault();
        go(-1);
      } else if (e.key === 'ArrowRight' || e.key === ']') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  const dirty = useMemo(() => {
    const st = active ? viewState.current.get(active.key) : undefined;
    return !!st?.dirty;
  }, [active, disk, mode, dirtyTick]);

  const save = async () => {
    if (!cwd || !active || binary) return;
    const content = taRef.current?.value ?? viewState.current.get(active.key)?.draft ?? disk;
    setSaving(true);
    setErr(null);
    try {
      const r = await harnessClient.workspaceWrite(
        cwd,
        workspaceRelPath(cwd, active.path),
        content,
      );
      if (!r.ok) {
        setErr(r.code === 'outside' ? t('路径不在工作区内，已拒绝写入') : r.error || t('保存失败'));
        return;
      }
      setDisk(content);
      const st = viewState.current.get(active.key) ?? {
        scrollTop: 0,
        selStart: 0,
        selEnd: 0,
      };
      st.dirty = false;
      st.draft = content;
      viewState.current.set(active.key, st);
      setDirtyTick((n) => n + 1);
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const discardTurn = async () => {
    if (!cwd || !active?.change?.diff || active.change.diff.summaryOnly) {
      setErr(t('没有可丢弃的完整 diff'));
      return;
    }
    const old = reconstructOldText(active.change.diff.diff);
    if (old == null) {
      setErr(t('没有可丢弃的完整 diff'));
      return;
    }
    if (!window.confirm(t('丢弃本轮对该文件的变更并写回旧内容？'))) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await harnessClient.workspaceWrite(cwd, workspaceRelPath(cwd, active.path), old);
      if (!r.ok) {
        setErr(r.code === 'outside' ? t('路径不在工作区内，已拒绝写入') : r.error || t('保存失败'));
        return;
      }
      setDisk(old);
      if (taRef.current) taRef.current.value = old;
      const st = viewState.current.get(active.key);
      if (st) {
        st.dirty = false;
        st.draft = old;
      }
      setDirtyTick((n) => n + 1);
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!active) return null;

  const hasDiff = !!(active.change?.diff || active.gitDiff);
  const isMd = isMarkdownPath(active.path);
  // 预览渲染未保存的草稿（切到预览前 persistView 已存下）
  const renderText = viewState.current.get(active.key)?.draft ?? disk;

  return (
    <div className={styles.preview} data-testid="file-preview" tabIndex={-1}>
      <header className={styles.previewHead}>
        <div className={styles.previewNav}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => go(-1)}
            aria-label={t('上一个文件')}
            data-testid="preview-prev"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => go(1)}
            aria-label={t('下一个文件')}
            data-testid="preview-next"
          >
            <ChevronRight size={14} />
          </button>
          <span className={styles.previewCount}>
            {idx + 1}/{files.length}
          </span>
        </div>
        <nav className={styles.crumbs} aria-label={t('文件路径')}>
          {crumbs.map((c, i) => (
            <React.Fragment key={`${c}-${i}`}>
              {i > 0 ? <span className={styles.crumbSep}>/</span> : null}
              <span className={styles.crumb} data-last={i === crumbs.length - 1 || undefined}>
                {c}
              </span>
            </React.Fragment>
          ))}
        </nav>
        <div className={styles.previewActions}>
          <div className={styles.modeTabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'diff'}
              data-active={mode === 'diff' || undefined}
              className={styles.modeTab}
              disabled={!hasDiff}
              onClick={() => {
                persistView();
                setMode('diff');
              }}
            >
              Diff
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'file'}
              data-active={mode === 'file' || undefined}
              className={styles.modeTab}
              onClick={() => {
                persistView();
                setMode('file');
              }}
              data-testid="preview-mode-file"
              title={t('编辑文件内容，保存后写回工作区')}
            >
              <FileCode2 size={12} />
              {t('编辑')}
            </button>
            {isMd ? (
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'render'}
                data-active={mode === 'render' || undefined}
                className={styles.modeTab}
                onClick={() => {
                  persistView();
                  setMode('render');
                }}
                data-testid="preview-mode-render"
              >
                <Eye size={12} />
                {t('预览')}
              </button>
            ) : null}
          </div>
          {mode !== 'diff' && !binary && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => void save()}
              disabled={saving || !cwd}
              title={t('保存到工作区')}
              aria-label={t('保存到工作区')}
              data-testid="preview-save"
            >
              <Save size={14} />
            </button>
          )}
          {active.change?.diff && !active.change.diff.summaryOnly && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => void discardTurn()}
              disabled={saving || !cwd}
              title={t('丢弃本轮变更')}
              aria-label={t('丢弃本轮变更')}
              data-testid="preview-discard"
            >
              <RotateCcw size={14} />
            </button>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            aria-label={t('关闭预览')}
            data-testid="preview-close"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {!hideFileTabs && (
        <div className={styles.fileTabs} role="tablist" data-testid="preview-file-tabs">
          {files.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={f.key === active.key}
              data-active={f.key === active.key || undefined}
              className={styles.fileTab}
              title={f.path}
              onClick={() => {
                persistView();
                onActiveKey(f.key);
              }}
            >
              {f.letter ? (
                <span className={styles.letter} data-letter={f.letter}>
                  {f.letter}
                </span>
              ) : null}
              <span className={styles.fileTabName}>{f.path.split(/[/\\]/).pop()}</span>
              {f.added || f.removed ? (
                <span className={styles.stat}>
                  {f.added ? <span className={styles.add}>+{f.added}</span> : null}
                  {f.removed ? <span className={styles.del}>−{f.removed}</span> : null}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      {err ? (
        <p className={styles.previewErr} data-testid="preview-error">
          {err}
        </p>
      ) : null}

      {mode === 'diff' ? (
        <div
          ref={bodyRef}
          className={styles.previewBody}
          data-testid="preview-diff-body"
          onScroll={() => persistView()}
        >
          {active.change?.diff ? (
            <DiffView diff={active.change.diff} cwd={cwd} fill split="auto" />
          ) : active.gitDiff ? (
            <DiffView diff={active.gitDiff} cwd={cwd} fill split="auto" />
          ) : (
            <p className={styles.empty}>{t('无 diff，可切换到「文件」查看磁盘内容')}</p>
          )}
        </div>
      ) : mode === 'render' ? (
        <div className={styles.previewBody} data-testid="preview-render-body">
          {loading ? (
            <p className={styles.empty}>{t('读取中…')}</p>
          ) : (
            <Markdown text={renderText} className={styles.mdPreview} settled />
          )}
          {dirty ? <span className={styles.dirtyHint}>{t('未保存')}</span> : null}
        </div>
      ) : (
        <div className={styles.previewBody} data-testid="preview-file-body">
          {loading ? (
            <p className={styles.empty}>{t('读取中…')}</p>
          ) : binary ? (
            <p className={styles.empty}>{t('二进制文件，无法在预览中编辑')}</p>
          ) : (
            <textarea
              ref={taRef}
              className={styles.editor}
              defaultValue={disk}
              spellCheck={false}
              data-testid="preview-editor"
              aria-label={t('编辑文件')}
              onChange={(e) => {
                const st = viewState.current.get(active.key) ?? {
                  scrollTop: 0,
                  selStart: 0,
                  selEnd: 0,
                };
                st.draft = e.target.value;
                st.dirty = e.target.value !== disk;
                viewState.current.set(active.key, st);
                setDirtyTick((n) => n + 1);
              }}
              onScroll={() => persistView()}
              onSelect={() => persistView()}
            />
          )}
          {dirty ? <span className={styles.dirtyHint}>{t('未保存')}</span> : null}
        </div>
      )}
    </div>
  );
};
