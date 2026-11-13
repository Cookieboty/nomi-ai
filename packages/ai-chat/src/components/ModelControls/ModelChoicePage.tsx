/** 模型浮层里的账号 / 第三方供应商选择：共用同一行样式与内嵌列表。 */
import { Icon, Select, type SelectOption } from '@nomi-ai/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import React from 'react';

import styles from './index.module.css';

export interface ModelChoiceSource {
  title: string;
  rowLabel: string;
  rowValue: string;
  rowAriaLabel: string;
  value: string;
  options: SelectOption[];
}

export const ModelChoiceRow: React.FC<{
  source: ModelChoiceSource;
  testId: string;
  onClick: () => void;
}> = ({ source, testId, onClick }) => (
  <button
    type="button"
    className={styles.modelRow}
    data-testid={testId}
    aria-label={source.rowAriaLabel}
    onClick={onClick}
  >
    <span className={styles.modelRowLabel}>{source.rowLabel}</span>
    <span className={styles.modelRowValue}>
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
    <Select
      inline
      size="sm"
      inlineMaxHeight={300}
      aria-label={source.title}
      data-testid={`${prefix}-picker`}
      value={source.value}
      options={source.options}
      onChange={(e) => onChange(e.target.value)}
      onOpenChange={onOpenChange}
    />
  </>
);
