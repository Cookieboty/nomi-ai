/**
 * 设置分区的统一「标题 + 说明 + 标签页」外壳（样式与「编程助手」页的标签一致）。
 * - 标签是 WAI-ARIA tablist：左右方向键 / Home / End 切换并移动焦点（roving tabindex）；
 * - 只渲染当前标签的内容（面板各自懒加载、切换分区时的状态行为与原先一致）。
 */
import { t } from '@nomi-ai/ui';
import React, { useId, useRef } from 'react';

import styles from './SectionPage.module.css';

export interface SectionTabDef<T extends string> {
  id: T;
  /** 中文文案（i18n key），渲染时过 t() */
  label: string;
}

interface Props<T extends string> {
  /** 外层 data-testid，标签为 `<testId>-tab-<id>`，面板为 `<testId>-panel` */
  testId: string;
  title: string;
  intro: React.ReactNode;
  tabsLabel: string;
  tabs: ReadonlyArray<SectionTabDef<T>>;
  value: T;
  onChange: (tab: T) => void;
  children: React.ReactNode;
}

export function SectionPage<T extends string>({
  testId,
  title,
  intro,
  tabsLabel,
  tabs,
  value,
  onChange,
  children,
}: Props<T>): React.ReactElement {
  const uid = useId();
  const refs = useRef(new Map<T, HTMLButtonElement>());

  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((x) => x.id === value);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i + tabs.length - 1) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    const next = tabs[n]!.id;
    onChange(next);
    refs.current.get(next)?.focus();
  };

  return (
    <div className={styles.page} data-testid={testId} data-tab={value}>
      <div className={styles.head}>
        <h2 className={styles.title}>{t(title)}</h2>
        <p className={styles.sub}>{intro}</p>
        <div
          role="tablist"
          aria-label={t(tabsLabel)}
          className={styles.tabs}
          data-testid={`${testId}-tabs`}
          onKeyDown={onKey}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) refs.current.set(tab.id, el);
                else refs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${tab.id}`}
              aria-selected={value === tab.id}
              aria-controls={`${uid}-panel`}
              tabIndex={value === tab.id ? 0 : -1}
              className={`${styles.tab} ${value === tab.id ? styles.tabOn : ''}`}
              data-testid={`${testId}-tab-${tab.id}`}
              onClick={() => onChange(tab.id)}
            >
              {t(tab.label)}
            </button>
          ))}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${uid}-panel`}
        aria-labelledby={`${uid}-tab-${value}`}
        className={styles.panel}
        data-testid={`${testId}-panel`}
      >
        {children}
      </div>
    </div>
  );
}
