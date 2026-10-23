/** Codex 风格：助手消息下方「已编辑 N 个文件」摘要卡 */
import { t } from '@nomi-ai/ui';
import { ChevronDown, ChevronRight, Expand, ExternalLink, FileDiff, RotateCcw } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { harnessClient } from '../../services/harnessClient';
import { splitPathDisplay, summarizeChanges, type ChangeEntry } from '../../utils/sessionChanges';
import { undoTurnChanges } from '../../utils/undoTurnChanges';
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
  /** 少文件模式下各文件 Diff 折叠态；默认展开 */
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

  const onUndo = async () => {
    if (!cwd) {
      window.alert(t('当前会话没有工作目录'));
      return;
    }
    if (
      !window.confirm(t('撤销本轮对这些文件的写入？仅限工作区内，写回旧内容或安全 git checkout。'))
    ) {
      return;
    }
    setBusy(true);
    try {
      const results = await undoTurnChanges(cwd, entries, {
        write: (c, rel, content) => harnessClient.workspaceWrite(c, rel, content),
        remove: (c, rel) => harnessClient.workspaceDelete(c, rel),
        gitCheckout: (c, rel) => harnessClient.workspaceGitCheckout(c, rel),
      });
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        window.alert(
          t('部分文件撤销失败：{0}', failed.map((f) => `${f.file}: ${f.error || '?'}`).join('\n')),
        );
      } else {
        setUndone(true);
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isDiffOpen = (file: string) => diffOpen[file] !== false;

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
              {t('已编辑 {0} 个文件', summary.files)}
            </strong>
          </div>
          <button
            type="button"
            className={styles.turnCardLink}
            onClick={open}
            data-testid="turn-view-changes-link"
          >
            {t('查看变更')}
            <ExternalLink size={12} />
          </button>
        </div>
        <div className={styles.turnCardActions}>
          <button
            type="button"
            className={styles.turnUndo}
            onClick={() => void onUndo()}
            disabled={busy || !cwd}
            data-testid="turn-undo"
          >
            <RotateCcw size={14} />
            {t('撤销')}
          </button>
          <button
            type="button"
            className={styles.turnFullscreen}
            onClick={openFullscreen}
            data-testid="turn-open-fullscreen"
            title={t('全屏审查')}
          >
            <Expand size={14} />
            {t('全屏审查')}
          </button>
          <button
            type="button"
            className={styles.turnPrimary}
            onClick={open}
            data-testid="turn-view-changes"
          >
            {t('查看变更')}
          </button>
        </div>
      </div>

      {inline ? (
        <div className={styles.turnInlineDiffs} data-testid="turn-inline-diffs">
          {entries.map((e) => {
            const { dir, name } = splitPathDisplay(e.file);
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
                    <DiffView diff={e.diff} />
                  </div>
                ) : null}
                {openFile && !e.diff ? (
                  <p className={styles.turnInlineEmpty}>{t('无行级 Diff')}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <ul className={styles.turnFileList}>
            {shown.map((e) => {
              const { dir, name } = splitPathDisplay(e.file);
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
              {t('再显示 {0} 个文件', more)}
              <ChevronDown size={14} />
            </button>
          ) : null}
        </>
      )}
    </div>
  );
};
