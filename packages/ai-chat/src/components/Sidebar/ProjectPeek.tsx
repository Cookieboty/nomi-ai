/**
 * 项目详情悬停弹窗：鼠标悬停侧栏项目头时在右侧弹出，展示跨端总聊天数、
 * 全部源文件夹、项目置顶开关以及「编辑项目」快捷入口。
 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import {
  IconFolder as Folder,
  IconFolderRoot as FolderRoot,
  IconMessageCircle as MessageCircle,
  IconPin as Pin,
  IconPinned as Pinned,
  IconSettings as Settings,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { projectRoots } from '../../services/projects';
import { workspaceKey } from '../../utils/workspacePath';

import type { ProjectGroup } from './projectGrouping';
import styles from './ProjectPeek.module.css';

const HIDE_DELAY = 180;
const GAP = 8;
const EDGE = 8;

export interface ProjectPeekState {
  projectId: string;
  anchor: HTMLElement;
}

/**
 * 项目悬停卡片状态管理：
 * - 首次进入延迟 `delay` 毫秒后弹出，避免鼠标快速划过整列时闪烁；
 * - 卡片已显示时切到相邻项目立即更新，移出后延迟 `HIDE_DELAY` 收起以便鼠标进入卡片交互。
 */
export function useProjectPeek(delay = 220) {
  const [peek, setPeek] = useState<ProjectPeekState | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const openRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const hide = useCallback(() => {
    clear();
    openRef.current = false;
    setPeek(null);
  }, [clear]);

  const onPeek = useCallback(
    (projectId: string, el: HTMLElement | null) => {
      clear();
      if (!el) {
        timerRef.current = window.setTimeout(() => {
          openRef.current = false;
          setPeek(null);
        }, HIDE_DELAY);
        return;
      }
      const show = () => {
        openRef.current = true;
        setPeek({ projectId, anchor: el });
      };
      if (openRef.current || delay <= 0) show();
      else timerRef.current = window.setTimeout(show, delay);
    },
    [clear, delay],
  );

  const hold = useCallback(() => clear(), [clear]);

  const release = useCallback(() => {
    clear();
    timerRef.current = window.setTimeout(() => {
      openRef.current = false;
      setPeek(null);
    }, HIDE_DELAY);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return { peek, onPeek, hide, hold, release };
}

export const ProjectPeek: React.FC<{
  group: ProjectGroup;
  anchor: HTMLElement;
  onTogglePin: (projectId: string) => void;
  onEdit: (group: ProjectGroup) => void;
  onHold: () => void;
  onRelease: () => void;
  onClose: () => void;
}> = ({ group, anchor, onTogglePin, onEdit, onHold, onRelease, onClose }) => {
  useLocale();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const folders = projectRoots(group.project);
  const missingSet = new Set((group.project.missing ?? []).map(workspaceKey));
  const pinned = Boolean(group.pinnedAt);
  const pinLabel = pinned ? t('ui.knowledge-local.unpin') : t('ui.cli-monitor.project-pin');

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = a.right + GAP;
    if (left + w > window.innerWidth - EDGE) left = Math.max(EDGE, a.left - GAP - w);
    const top = Math.max(EDGE, Math.min(a.top, window.innerHeight - EDGE - h));
    setPos({ left, top });
  }, [anchor, folders.length, group.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      ref={cardRef}
      className={styles.card}
      style={pos}
      role="dialog"
      aria-label={group.project.name}
      data-testid="project-peek"
      data-project={group.key}
      onMouseEnter={onHold}
      onMouseLeave={onRelease}
    >
      <div className={styles.header}>
        <span className={styles.folderLead} aria-hidden>
          <Icon icon={Folder} size={16} />
        </span>
        <span className={styles.title} title={group.project.name}>
          {group.project.name}
        </span>
        <button
          type="button"
          className={styles.pinBtn}
          aria-label={pinLabel}
          aria-pressed={pinned}
          data-pinned={pinned || undefined}
          data-testid="project-peek-pin"
          onClick={() => onTogglePin(group.project.id)}
        >
          <Icon icon={pinned ? Pinned : Pin} size={15} />
        </button>
      </div>

      <div className={styles.stats} data-testid="project-peek-chats">
        <Icon icon={MessageCircle} size={14} />
        <span>{t('ui.cli-monitor.project-chat-count', group.totalChats)}</span>
      </div>

      <div className={styles.divider} role="separator" />

      <div className={styles.folders} data-testid="project-peek-folders">
        {folders.map((dir, idx) => {
          const isMissing = missingSet.has(workspaceKey(dir));
          const tip = isMissing ? `${dir}\n${t('ui.cli-monitor.project-folder-missing')}` : dir;
          return (
            <div
              key={dir}
              className={styles.folderRow}
              data-testid="project-peek-folder"
              data-primary={idx === 0 || undefined}
              data-missing={isMissing || undefined}
            >
              <Icon icon={idx === 0 ? FolderRoot : Folder} size={14} />
              <span className={styles.folderPath} title={tip}>
                {dir}
              </span>
            </div>
          );
        })}
      </div>

      <div className={styles.divider} role="separator" />

      <button
        type="button"
        className={styles.editBtn}
        data-testid="project-peek-edit"
        onClick={() => {
          onClose();
          onEdit(group);
        }}
      >
        <Icon icon={Settings} size={14} />
        <span>{t('ui.cli-monitor.project-edit-title')}</span>
      </button>
    </div>,
    document.body,
  );
};
