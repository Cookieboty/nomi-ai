/**
 * 设置分区的统一「标签页」外壳（标题与说明由 SettingsView 页头统一渲染）（样式与「Agents」页的标签一致）。
 * - 标签是 WAI-ARIA tablist：左右方向键 / Home / End 切换并移动焦点（roving tabindex）；
 * - 只渲染当前标签的内容（面板各自懒加载、切换分区时的状态行为与原先一致）。
 */
import { t, useLocale, useTabIndicator } from '@nomi-ai/ui';
import React, { useId, useMemo, useRef } from 'react';

import { useDirectionalTabMotion } from '../../hooks/useTabMotion';

import styles from './SectionPage.module.css';

export interface SectionTabDef<T extends string> {
  id: T;
  /** 中文文案（i18n key），渲染时过 t() */
  label: string;
}

interface Props<T extends string> {
  /** 外层 data-testid，标签为 `<testId>-tab-<id>`，面板为 `<testId>-panel` */
  testId: string;
  tabsLabel: string;
  tabs: ReadonlyArray<SectionTabDef<T>>;
  value: T;
  onChange: (tab: T) => void;
  /** 不在面板里滚动：随外层一起滚，标签滚到顶部后吸顶 */
  stickyHead?: boolean;
  children: React.ReactNode;
}

export function SectionPage<T extends string>({
  testId,
  tabsLabel,
  tabs,
  value,
  onChange,
  stickyHead,
  children,
}: Props<T>): React.ReactElement {
  const uid = useId();
  const locale = useLocale();
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const tabKeys = useMemo(() => tabs.map((x) => x.id), [tabs]);
  const panelMotion = useDirectionalTabMotion(tabKeys, value);
  const { listRef, indicator } = useTabIndicator<HTMLDivElement>(
    `${value}\0${locale}\0${tabs.length}`,
  );

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
    <div
      className={styles.page}
      data-testid={testId}
      data-tab={value}
      data-sticky-head={stickyHead || undefined}
    >
      <div className={styles.head}>
        <div
          ref={listRef}
          role="tablist"
          aria-label={t(tabsLabel)}
          data-sliding={indicator.visible ? 'true' : undefined}
          className={styles.tabs}
          data-testid={`${testId}-tabs`}
          onKeyDown={onKey}
        >
          {indicator.visible && (
            <span
              aria-hidden="true"
              data-animate={indicator.animate ? 'true' : undefined}
              className={styles.tabIndicator}
              style={{
                width: `${indicator.width}px`,
                height: `${indicator.height}px`,
                transform: `translate3d(${indicator.left}px, ${indicator.top}px, 0)`,
              }}
            />
          )}
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
        data-tab-motion={panelMotion}
        data-testid={`${testId}-panel`}
      >
        {children}
      </div>
    </div>
  );
}
