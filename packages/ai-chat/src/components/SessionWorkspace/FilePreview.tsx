/**
 * 多文件预览：Tab / 面包屑、切文件保留滚动与选区、←→ 切文件、
 * 磁盘内容可编辑保存（cwd 沙箱）、可选丢弃本轮 diff。
 */
import { t } from '@nomi-ai/ui';
import { ChevronLeft, ChevronRight, Eye, FileCode2, RotateCcw, Save, X } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { harnessClient } from '../../services/harnessClient';
import { shouldIgnoreEscape } from '../../utils/keyboard';
import type { ChangeEntry } from '../../utils/sessionChanges';
import type { FileDiff } from '../../utils/toolTrace';
import { undoErrorText, undoTurnChanges } from '../../utils/undoTurnChanges';
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
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [disk, setDisk] = useState<string>('');
  const [binary, setBinary] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 应用内确认「丢弃本轮变更」（取代 window.confirm） */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** 每个文件的草稿 / 是否有未保存改动（渲染要用，所以放 state；滚动 / 选区不参与渲染，留在 viewState） */
  const [meta, setMeta] = useState<Record<string, { draft?: string; dirty?: boolean }>>({});
  const commitMeta = useCallback((key: string, draft: string | undefined, dirty: boolean) => {
    setMeta((m) =>
      m[key]?.draft === draft && !!m[key]?.dirty === dirty ? m : { ...m, [key]: { draft, dirty } },
    );
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewState = useRef<Map<string, FileViewState>>(new Map());
  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const idx = Math.max(
    0,
    files.findIndex((f) => f.key === activeKey),
  );
  const active = files[idx] ?? files[0];

  // 换文件时：有 diff 先看 Diff，没有就直接编辑。只看文件和有没有 diff，
  // 列表刷新（窗口重新聚焦会刷新 git）不打断正在编辑 / 预览的文件。
  // 在渲染期就把模式 / 待确认丢弃重置好（而不是等 effect 之后再来一次渲染）：
  // 读盘 effect 只会看到最终的模式，切文件不会为旧模式多读一次盘
  const activeHasDiff = !!(active?.change?.diff || active?.gitDiff);
  const [mode, setMode] = useState<PreviewMode>(activeHasDiff ? 'diff' : 'file');
  const [modeKey, setModeKey] = useState(activeKey);
  if (modeKey !== activeKey) {
    setModeKey(activeKey);
    setMode(activeHasDiff ? 'diff' : 'file');
    setConfirmDiscard(false); // 确认的是上一个文件
  }

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
      commitMeta(active.key, prev.draft, prev.dirty);
    } else if (bodyRef.current) {
      prev.scrollTop = bodyRef.current.scrollTop;
    }
    viewState.current.set(active.key, prev);
  }, [active, commitMeta, disk, mode]);

  const go = useCallback(
    (delta: number) => {
      if (!files.length) return;
      persistView();
      const next = (idx + delta + files.length) % files.length;
      onActiveKey(files[next]!.key);
    },
    [files, idx, onActiveKey, persistView],
  );

  const pendingRestore = useRef<{ key: string; disk: string } | null>(null);
  useLayoutEffect(() => {
    const p = pendingRestore.current;
    const ta = taRef.current;
    if (!p || !ta || p.key !== active?.key) return;
    pendingRestore.current = null;
    // 提交时才取草稿：读盘返回到编辑框重新渲染之间用户已经输入的内容不能被盖掉
    const st = viewState.current.get(p.key);
    ta.value = st?.dirty && st.draft != null ? st.draft : p.disk;
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
      setErr(cwd ? null : t('ui.session-workspace.this-session-has-no-working-directory'));
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
            ? t('ui.session-workspace.path-outside-workspace-read-denied')
            : r.code === 'not-found'
              ? t('ui.session-workspace.file-not-found-may-not-be-on-disk')
              : r.error || t('ui.slash-commands.failed-to-read'),
        );
        return;
      }
      if (r.binary) {
        setBinary(true);
        setDisk('');
        return;
      }
      setBinary(false);
      setDisk(r.content ?? '');
      // 读取期间编辑框被卸载：等它重新渲染出来再写回草稿与滚动 / 选区（见下方 layout effect）
      pendingRestore.current = { key: activeFileKey, disk: r.content ?? '' };
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeFileKey, activePath, cwd]);

  useEffect(() => {
    // loadDisk 是「读盘 → 写 state」的数据同步，loading / 重置 state 在其开头同步设置是有意的
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (mode === 'file' || mode === 'render') void loadDisk();
    else {
      requestAnimationFrame(() => {
        const el = bodyRef.current;
        const st = activeFileKey ? viewState.current.get(activeFileKey) : undefined;
        if (el && st) el.scrollTop = st.scrollTop;
      });
    }
  }, [activeFileKey, mode, loadDisk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === 'Escape') {
        // 聊天输入框等预览之外的输入控件里按 Esc 不关预览；预览自己的编辑框仍可 Esc 关闭
        if (shouldIgnoreEscape(e, (tg) => !!rootRef.current?.contains(tg as Node))) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
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
        setErr(
          r.code === 'outside'
            ? t('ui.session-workspace.path-outside-workspace-write-denied')
            : r.error || t('ui.voice-mascot.couldn-t-save'),
        );
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
      commitMeta(active.key, content, false);
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const askDiscard = () => {
    if (!cwd || !active?.change?.diff || active.change.diff.summaryOnly) {
      setErr(t('ui.session-workspace.no-full-diff-available-to-discard'));
      return;
    }
    setErr(null);
    setConfirmDiscard(true);
  };

  const discardTurn = async () => {
    setConfirmDiscard(false);
    if (!cwd || !active?.change?.diff || active.change.diff.summaryOnly) return;
    setSaving(true);
    setErr(null);
    try {
      // 只把本轮改的那几处换回旧内容（不是用一小段 diff 覆盖整个文件）；文件之后又被改过则拒绝
      const [r] = await undoTurnChanges(cwd, [active.change], {
        read: (c, rel) => harnessClient.workspaceRead(c, rel),
        write: (c, rel, content) => harnessClient.workspaceWrite(c, rel, content),
        remove: (c, rel) => harnessClient.workspaceDelete(c, rel),
        gitCheckout: (c, rel) => harnessClient.workspaceGitCheckout(c, rel),
      });
      if (!r?.ok) {
        setErr(undoErrorText(r?.error, t));
        return;
      }
      const st = viewState.current.get(active.key);
      if (st) {
        st.dirty = false;
        st.draft = undefined;
      }
      commitMeta(active.key, undefined, false);
      await loadDisk();
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
  const renderText = meta[active.key]?.draft ?? disk;
  const dirty = !!meta[active.key]?.dirty;

  return (
    <div ref={rootRef} className={styles.preview} data-testid="file-preview" tabIndex={-1}>
      <header className={styles.previewHead}>
        <div className={styles.previewNav}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => go(-1)}
            aria-label={t('ui.session-workspace.previous-file')}
            data-testid="preview-prev"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => go(1)}
            aria-label={t('ui.session-workspace.next-file')}
            data-testid="preview-next"
          >
            <ChevronRight size={14} />
          </button>
          <span className={styles.previewCount}>
            {idx + 1}/{files.length}
          </span>
        </div>
        <nav className={styles.crumbs} aria-label={t('ui.session-workspace.file-path')}>
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
              title={t('ui.session-workspace.edit-the-file-saving-writes-it-back-to')}
            >
              <FileCode2 size={12} />
              {t('ui.foundation.edit')}
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
                {t('ui.foundation.preview')}
              </button>
            ) : null}
          </div>
          {mode !== 'diff' && !binary && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => void save()}
              disabled={saving || !cwd}
              title={t('ui.session-workspace.save-to-workspace')}
              aria-label={t('ui.session-workspace.save-to-workspace')}
              data-testid="preview-save"
            >
              <Save size={14} />
            </button>
          )}
          {active.change?.diff && !active.change.diff.summaryOnly && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={askDiscard}
              disabled={saving || !cwd || confirmDiscard}
              title={t('ui.session-workspace.discard-turn-changes')}
              aria-label={t('ui.session-workspace.discard-turn-changes')}
              data-testid="preview-discard"
            >
              <RotateCcw size={14} />
            </button>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            aria-label={t('ui.session-workspace.close-preview')}
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

      {confirmDiscard ? (
        <div
          className={styles.turnConfirm}
          role="alertdialog"
          data-testid="preview-discard-confirm"
        >
          <span>{t('ui.session-workspace.discard-this-turn-s-changes-to-this-file')}</span>
          <span className={styles.turnConfirmBtns}>
            <button
              type="button"
              className={styles.turnConfirmCancel}
              onClick={() => setConfirmDiscard(false)}
              data-testid="preview-discard-cancel"
            >
              {t('ui.foundation.cancel')}
            </button>
            <button
              type="button"
              className={styles.turnConfirmOk}
              onClick={() => void discardTurn()}
              data-testid="preview-discard-ok"
            >
              {t('ui.session-workspace.confirm-discard')}
            </button>
          </span>
        </div>
      ) : null}

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
            <p className={styles.empty}>
              {t('ui.session-workspace.no-diff-switch-to-file-to-view-disk')}
            </p>
          )}
        </div>
      ) : mode === 'render' ? (
        <div className={styles.previewBody} data-testid="preview-render-body">
          {loading ? (
            <p className={styles.empty}>{t('ui.session-workspace.reading')}</p>
          ) : (
            <Markdown text={renderText} className={styles.mdPreview} settled />
          )}
          {dirty ? (
            <span className={styles.dirtyHint}>{t('ui.session-workspace.unsaved')}</span>
          ) : null}
        </div>
      ) : (
        <div className={styles.previewBody} data-testid="preview-file-body">
          {loading ? (
            <p className={styles.empty}>{t('ui.session-workspace.reading')}</p>
          ) : binary ? (
            <p className={styles.empty}>
              {t('ui.session-workspace.binary-file-cannot-edit-in-preview')}
            </p>
          ) : (
            <textarea
              ref={taRef}
              className={styles.editor}
              defaultValue={disk}
              spellCheck={false}
              data-testid="preview-editor"
              aria-label={t('ui.session-workspace.edit-file')}
              onChange={(e) => {
                const st = viewState.current.get(active.key) ?? {
                  scrollTop: 0,
                  selStart: 0,
                  selEnd: 0,
                };
                st.draft = e.target.value;
                st.dirty = e.target.value !== disk;
                viewState.current.set(active.key, st);
                commitMeta(active.key, st.draft, !!st.dirty);
              }}
              onScroll={() => persistView()}
              onSelect={() => persistView()}
            />
          )}
          {dirty ? (
            <span className={styles.dirtyHint}>{t('ui.session-workspace.unsaved')}</span>
          ) : null}
        </div>
      )}
    </div>
  );
};
