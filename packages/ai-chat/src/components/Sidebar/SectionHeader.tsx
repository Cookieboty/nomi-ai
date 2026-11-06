/**
 * 侧栏分区标题（Codex 式）：灰色小字 + 后面的「>」，点一下收起 / 展开整个分区，展开时箭头转向下。
 * 「工作区」「最近」「本机历史」共用。
 */
import { Icon } from '@nomi-ai/ui';
import { ChevronRight } from 'lucide-react';
import React from 'react';

import styles from './index.module.css';

export const SectionHeader: React.FC<{
  label: string;
  open: boolean;
  onToggle: () => void;
  testId: string;
  /** 悬停提示（缺省用 label） */
  title?: string;
  /** 标题右侧的按钮（整理「…」、新建「+」、刷新） */
  actions?: React.ReactNode;
}> = ({ label, open, onToggle, testId, title, actions }) => (
  <div className={styles.secHead}>
    <button
      type="button"
      className={styles.secToggle}
      aria-expanded={open}
      title={title ?? label}
      onClick={onToggle}
      data-testid={testId}
    >
      <span>{label}</span>
      <span className={styles.secChevron} data-open={open || undefined} aria-hidden>
        <Icon icon={ChevronRight} size={14} />
      </span>
    </button>
    {actions && <span className={styles.secActions}>{actions}</span>}
  </div>
);
