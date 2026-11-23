/** 模型浮层里的账号 / 第三方供应商选择：共用同一行样式与内嵌列表。 */
import { Icon, Select, type SelectOption } from '@nomi-ai/ui';
import {
  IconChevronLeft as ChevronLeft,
  IconChevronRight as ChevronRight,
} from '@tabler/icons-react';
import React from 'react';

import styles from './index.module.css';

export interface ModelChoiceSource {
  title: string;
  rowLabel: string;
  rowValue: string;
  rowAriaLabel: string;
  rowIcon?: React.ReactNode;
  disabled?: boolean;
  searchable?: boolean;
  header?: React.ReactNode | ((actions: { toEffort: () => void }) => React.ReactNode);
  footer?: React.ReactNode;
  value: string;
  options: SelectOption[];
}

export const ModelChoiceRow: React.FC<{
  source: ModelChoiceSource;
  testId: string;
  position?: 'top' | 'bottom';
  onClick: () => void;
}> = ({ source, testId, position = 'bottom', onClick }) => (
  <button
    type="button"
    className={position === 'top' ? `${styles.modelRow} ${styles.modelRowTop}` : styles.modelRow}
    data-testid={testId}
    aria-label={source.rowAriaLabel}
    disabled={source.disabled}
    onClick={onClick}
  >
    <span className={styles.modelRowLabel}>{source.rowLabel}</span>
    <span className={styles.modelRowValue}>
      {source.rowIcon}
      <span className={styles.modelLinkText}>{source.rowValue}</span>
    </span>
    <Icon icon={ChevronRight} size={14} />
  </button>
);

export const ModelChoicePage: React.FC<{
  source: ModelChoiceSource;
  prefix: string;
  onBack: () => void;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
}> = ({ source, prefix, onBack, onChange, onOpenChange }) => (
  <>
    <div className={styles.modelHead}>
      <button type="button" className={styles.back} data-testid={`${prefix}-back`} onClick={onBack}>
        <Icon icon={ChevronLeft} size={14} />
        {source.title}
      </button>
    </div>
    {typeof source.header === 'function' ? source.header({ toEffort: onBack }) : source.header}
    <Select
      inline
      size="sm"
      searchable={source.searchable}
      inlineMaxHeight={300}
      aria-label={source.title}
      data-testid={`${prefix}-picker`}
      value={source.value}
      options={source.options}
      onChange={(e) => onChange(e.target.value)}
      onOpenChange={onOpenChange}
    />
    {source.footer}
  </>
);
