/** 工作区 / 变更文件树（右栏横排「文件」侧；详情页共用） */
import { ChevronDown, ChevronRight, FileCode2, LocateFixed } from 'lucide-react';
import React, { useState } from 'react';

import type { ChangeTreeNode } from '../../utils/sessionChanges';

import styles from './SessionWorkspace.module.css';

export const ChangeFileTree: React.FC<{
  nodes: ChangeTreeNode[];
  depth?: number;
  active: string | null;
  onPick: (file: string) => void;
  filter?: string;
  testIdPrefix?: string;
  /** 可选：定位到会话中的编辑步骤 */
  onLocate?: (file: string, messageId?: string) => void;
  messageIdByFile?: Record<string, string>;
}> = ({
  nodes,
  depth = 0,
  active,
  onPick,
  filter = '',
  testIdPrefix = 'wb',
  onLocate,
  messageIdByFile,
}) => {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const q = filter.trim().toLowerCase();
  const match = (path: string) => !q || path.toLowerCase().includes(q);

  return (
    <>
      {nodes.map((n) => {
        if (n.kind === 'dir') {
          const any =
            !q ||
            n.children.some(function walk(c): boolean {
              return c.kind === 'file' ? match(c.path) : c.children.some(walk);
            });
          if (!any) return null;
          const isOpen = open[n.path] ?? true;
          return (
            <div key={n.path || n.name} className={styles.wbTreeDir}>
              <button
                type="button"
                className={styles.wbTreeDirHead}
                style={{ paddingLeft: 8 + depth * 12 }}
                onClick={() => setOpen((o) => ({ ...o, [n.path]: !isOpen }))}
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className={styles.wbFileName} title={n.path}>
                  {n.name || '/'}
                </span>
              </button>
              {isOpen ? (
                <ChangeFileTree
                  nodes={n.children}
                  depth={depth + 1}
                  active={active}
                  onPick={onPick}
                  filter={filter}
                  testIdPrefix={testIdPrefix}
                  onLocate={onLocate}
                  messageIdByFile={messageIdByFile}
                />
              ) : null}
            </div>
          );
        }
        if (!match(n.path)) return null;
        const e = n.entry;
        const changed = !!e;
        // 工作区全树里节点是相对路径、变更是原路径：选中 / 高亮统一用变更的原路径
        const id = e?.file ?? n.path;
        return (
          <div
            key={n.path}
            className={styles.wbTreeFileRow}
            data-active={active === id || undefined}
            data-changed={changed || undefined}
            data-testid="change-row"
            data-file={n.path}
          >
            <button
              type="button"
              className={styles.wbTreeFile}
              style={{ paddingLeft: 8 + depth * 12 }}
              data-active={active === id || undefined}
              data-changed={changed || undefined}
              data-testid={`${testIdPrefix}-file`}
              data-file={n.path}
              onClick={() => onPick(id)}
            >
              <FileCode2 size={14} className={styles.wbFileIcon} />
              <span className={styles.wbFileName} title={n.path}>
                {n.name}
              </span>
              {changed ? <span className={styles.wbDot} aria-hidden /> : null}
              {e ? (
                <span className={styles.stat}>
                  <span className={styles.add}>+{e.added}</span>
                  <span className={styles.del}>−{e.removed}</span>
                </span>
              ) : null}
            </button>
            {onLocate && e?.messageId ? (
              <button
                type="button"
                className={styles.iconBtn}
                data-testid="change-locate"
                title="locate"
                aria-label="locate"
                onClick={() => onLocate(id, messageIdByFile?.[id] ?? e.messageId)}
              >
                <LocateFixed size={12} />
              </button>
            ) : null}
          </div>
        );
      })}
    </>
  );
};
