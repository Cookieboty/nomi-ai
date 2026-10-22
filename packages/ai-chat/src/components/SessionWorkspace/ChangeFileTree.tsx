/** 已更改文件树（右栏 / 详情页共用） */
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
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{n.name || '/'}</span>
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
        return (
          <div
            key={n.path}
            className={styles.wbTreeFileRow}
            data-active={active === n.path || undefined}
            data-testid="change-row"
            data-file={n.path}
          >
            <button
              type="button"
              className={styles.wbTreeFile}
              style={{ paddingLeft: 8 + depth * 12 }}
              data-active={active === n.path || undefined}
              data-testid={`${testIdPrefix}-file`}
              data-file={n.path}
              onClick={() => onPick(n.path)}
            >
              <FileCode2 size={12} className={styles.wbFileIcon} />
              <span className={styles.wbFileName} title={n.path}>
                {n.name}
              </span>
              <span className={styles.wbDot} aria-hidden />
              <span className={styles.stat}>
                <span className={styles.add}>+{e.added}</span>
                <span className={styles.del}>−{e.removed}</span>
              </span>
            </button>
            {onLocate ? (
              <button
                type="button"
                className={styles.iconBtn}
                data-testid="change-locate"
                title="locate"
                aria-label="locate"
                onClick={() => onLocate(n.path, messageIdByFile?.[n.path])}
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
