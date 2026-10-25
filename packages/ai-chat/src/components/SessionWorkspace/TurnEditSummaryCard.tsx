/** Codex 风格：助手消息下方「已编辑 N 个文件」摘要卡 */
import { t } from '@nomi-ai/ui';
import { ChevronDown, ChevronRight, Expand, ExternalLink, FileDiff, RotateCcw } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { harnessClient } from '../../services/harnessClient';
import { splitPathDisplay, summarizeChanges, type ChangeEntry } from '../../utils/sessionChanges';
import { undoErrorText, undoTurnChanges } from '../../utils/undoTurnChanges';
import { workspaceRelPath } from '../../utils/workspacePath';
import { DiffView } from '../Conversation/DiffView';

import { useChangesUi } from './ChangesUiContext';
import styles from './SessionWorkspace.module.css';

/**
 * 缩小版路径列表「再显示」预览条数。
 * 与 INLINE_DIFF_MAX_FILES 对齐：少文件展开行级 Diff，多文件才用缩小卡。
 */
const PREVIEW = 3;

/**
 * 文件数 ≤ 此阈值：卡内直接渲染各文件 DiffView（可折叠）；
 * ≥ 阈值+1：缩小版（标题 + 路径列表 +「再显示 N」）。
 * 依据：用户说明「文件特别多」才收成缩小卡 + 现有 PREVIEW=3；公开 Codex 资料无精确阈值。
 */
export const INLINE_DIFF_MAX_FILES = 3;

export const TurnEditSummaryCard: React.FC<{
  messageId: string;
  entries: ChangeEntry[];
  cwd?: string | null;
  sourceLabel?: string;
}> = ({ messageId, entries, cwd, sourceLabel }) => {
  const { openWorkbench, openDetail } = useChangesUi();
  const [expanded, setExpanded] = useState(false);
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 应用内确认 / 错误提示（取代 window.confirm / alert：在 Electron 里会打断焦点且无法统一样式） */
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 少文件模式下各文件 Diff 折叠态；默认收起（只列文件，点开再看行级 Diff，避免长 Diff 撑满对话） */
  const [diffOpen, setDiffOpen] = useState<Record<string, boolean>>({});
  const summary = useMemo(() => summarizeChanges(entries), [entries]);
  const inline = entries.length > 0 && entries.length <= INLINE_DIFF_MAX_FILES;
  const shown = expanded ? entries : entries.slice(0, PREVIEW);
  const more = Math.max(0, entries.length - PREVIEW);

  if (!entries.length || undone) return null;

  const open = () =>
    openWorkbench({
      messageId,
      entries,
      sourceLabel: sourceLabel || messageId.slice(0, 12),
      file: entries[0]?.file,
    });

  const openFullscreen = () =>
    openDetail({
      messageId,
      entries,
      sourceLabel: sourceLabel || messageId.slice(0, 12),
      file: entries[0]?.file,
    });

  const askUndo = () => {
    setNotice(null);
    if (!cwd) {
      setNotice(t('ui.session-workspace.this-session-has-no-working-directory'));
      return;
    }
    setConfirming(true);
  };

  const onUndo = async () => {
    if (!cwd) return;
    setConfirming(false);
    setBusy(true);
    try {
      const results = await undoTurnChanges(cwd, entries, {
        read: (c, rel) => harnessClient.workspaceRead(c, rel),
        write: (c, rel, content) => harnessClient.workspaceWrite(c, rel, content),
        remove: (c, rel) => harnessClient.workspaceDelete(c, rel),
        gitCheckout: (c, rel) => harnessClient.workspaceGitCheckout(c, rel),
      });
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        setNotice(
          t(
            'ui.session-workspace.some-files-failed-to-undo',
            failed.map((f) => `${f.file}: ${undoErrorText(f.error, t)}`).join('\n'),
          ),
        );
      } else {
        setUndone(true);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isDiffOpen = (file: string) => diffOpen[file] === true;

  const toggleDiff = (file: string) => {
    setDiffOpen((prev) => ({ ...prev, [file]: !isDiffOpen(file) }));
  };

  return (
    <div
      className={styles.turnCard}
      data-testid="turn-edit-summary"
      data-message-id={messageId}
      data-mode={inline ? 'inline' : 'compact'}
    >
      <div className={styles.turnCardTop}>
        <div className={styles.turnCardTitleCol}>
          <div className={styles.turnCardTitleRow}>
            <span className={styles.turnCardIcon} aria-hidden>
              <FileDiff size={16} />
            </span>
            <strong className={styles.turnCardTitle}>
              {t('ui.usage-tools.edited-files', summary.files)}
            </strong>
          </div>
          <button
            type="button"
            className={styles.turnCardLink}
            onClick={open}
            data-testid="turn-view-changes-link"
          >
            {t('ui.session-workspace.view-changes')}
            <ExternalLink size={12} />
          </button>
        </div>
        <div className={styles.turnCardActions}>
          <button
            type="button"
            className={styles.turnUndo}
            onClick={askUndo}
            disabled={busy || !cwd || confirming}
            data-testid="turn-undo"
          >
            <RotateCcw size={14} />
            {t('ui.mascot-theme.undo')}
          </button>
          <button
            type="button"
            className={styles.turnFullscreen}
            onClick={openFullscreen}
            data-testid="turn-open-fullscreen"
            title={t('ui.session-workspace.full-screen-review')}
          >
            <Expand size={14} />
            {t('ui.session-workspace.full-screen-review')}
          </button>
          <button
            type="button"
            className={styles.turnPrimary}
            onClick={open}
            data-testid="turn-view-changes"
          >
            {t('ui.session-workspace.view-changes')}
          </button>
        </div>
      </div>

      {confirming ? (
        <div className={styles.turnConfirm} role="alertdialog" data-testid="turn-undo-confirm">
          <span>{t('ui.session-workspace.undo-this-turn-s-writes-to-these-files')}</span>
          <span className={styles.turnConfirmBtns}>
            <button
              type="button"
              className={styles.turnConfirmCancel}
              onClick={() => setConfirming(false)}
              data-testid="turn-undo-cancel"
            >
              {t('ui.foundation.cancel')}
            </button>
            <button
              type="button"
              className={styles.turnConfirmOk}
              onClick={() => void onUndo()}
              data-testid="turn-undo-confirm-ok"
            >
              {t('ui.session-workspace.confirm-undo')}
            </button>
          </span>
        </div>
      ) : null}
      {notice ? (
        <div className={styles.turnNotice} role="alert" data-testid="turn-undo-notice">
          <span>{notice}</span>
          <button
            type="button"
            className={styles.turnConfirmCancel}
            onClick={() => setNotice(null)}
          >
            {t('ui.providers-schedule.close')}
          </button>
        </div>
      ) : null}

      {inline ? (
        <div className={styles.turnInlineDiffs} data-testid="turn-inline-diffs">
          {entries.map((e) => {
            const { dir, name } = splitPathDisplay(workspaceRelPath(cwd, e.file));
            const openFile = isDiffOpen(e.file);
            return (
              <div
                key={e.file}
                className={styles.turnInlineBlock}
                data-testid="turn-inline-diff"
                data-file={e.file}
                data-open={openFile || undefined}
              >
                <button
                  type="button"
                  className={styles.turnInlineToggle}
                  onClick={() => toggleDiff(e.file)}
                  aria-expanded={openFile}
                  data-testid="turn-inline-toggle"
                >
                  {openFile ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className={styles.turnPath} title={e.file}>
                    {dir ? <span className={styles.turnDir}>{dir}</span> : null}
                    <span className={styles.turnName}>{name}</span>
                  </span>
                  <span className={styles.stat}>
                    <span className={styles.add}>+{e.added}</span>
                    <span className={styles.del}>−{e.removed}</span>
                  </span>
                </button>
                {openFile && e.diff ? (
                  <div className={styles.turnInlineBody}>
                    <DiffView diff={e.diff} cwd={cwd} />
                  </div>
                ) : null}
                {openFile && !e.diff ? (
                  <p className={styles.turnInlineEmpty}>
                    {t('ui.session-workspace.no-line-level-diff')}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <ul className={styles.turnFileList}>
            {shown.map((e) => {
              const { dir, name } = splitPathDisplay(workspaceRelPath(cwd, e.file));
              return (
                <li key={e.file} className={styles.turnFileRow} data-testid="turn-edit-file">
                  <button
                    type="button"
                    className={styles.turnFileBtn}
                    onClick={() =>
                      openWorkbench({
                        messageId,
                        entries,
                        file: e.file,
                        sourceLabel: sourceLabel || messageId.slice(0, 12),
                      })
                    }
                  >
                    <span className={styles.turnPath} title={e.file}>
                      {dir ? <span className={styles.turnDir}>{dir}</span> : null}
                      <span className={styles.turnName}>{name}</span>
                    </span>
                    <span className={styles.stat}>
                      <span className={styles.add}>+{e.added}</span>
                      <span className={styles.del}>−{e.removed}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!expanded && more > 0 ? (
            <button
              type="button"
              className={styles.turnMore}
              onClick={() => setExpanded(true)}
              data-testid="turn-show-more"
            >
              {t('ui.session-workspace.show-more-files', more)}
              <ChevronDown size={14} />
            </button>
          ) : null}
        </>
      )}
    </div>
  );
};
