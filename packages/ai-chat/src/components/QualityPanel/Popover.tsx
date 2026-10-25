/**
 * 模型质量工具栏用的小弹层：芯片 / 图标按钮触发，Esc 或点外面关闭，关闭后焦点回到触发按钮。
 * 共享组件里没有通用弹层与多选下拉，这里只做面板需要的最小实现。
 */
import { BrandIcon, Icon, Input, t } from '@nomi-ai/ui';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import styles from './index.module.css';

export interface PopoverProps {
  /** 芯片文字；iconOnly 时作为无障碍名称 */
  label: React.ReactNode;
  /** 触发按钮的无障碍名称（label 不是纯文本时给） */
  ariaLabel?: string;
  icon?: LucideIcon;
  /** 只显示图标（工具栏右侧的设置等） */
  iconOnly?: boolean;
  /** 有选中值：芯片高亮 */
  active?: boolean;
  /** 弹层对齐触发按钮的左缘还是右缘 */
  align?: 'start' | 'end';
  /** 弹层的无障碍名称 */
  panelLabel: string;
  testId?: string;
  /** 受控打开（如选「自定义」时自动展开日期） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  minWidth?: number;
  children: (close: () => void) => React.ReactNode;
}

export const Popover: React.FC<PopoverProps> = ({
  label,
  ariaLabel,
  icon,
  iconOnly,
  active,
  align = 'start',
  panelLabel,
  testId,
  open: openProp,
  onOpenChange,
  minWidth,
  children,
}) => {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (v: boolean) => {
      if (openProp === undefined) setOpenState(v);
      onOpenChange?.(v);
    },
    [openProp, onOpenChange],
  );
  const wrap = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  // 关闭后焦点回到触发按钮（按 id 找，不在渲染期读 ref）
  const close = useCallback(() => {
    setOpen(false);
    document.getElementById(`${id}-trigger`)?.focus();
  }, [setOpen, id]);

  useEffect(() => {
    if (!open) return;
    // 打开后焦点进弹层：第一个可聚焦元素
    const first = panel.current?.querySelector<HTMLElement>(
      'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, setOpen]);

  return (
    <span className={styles.popWrap} ref={wrap}>
      <button
        id={`${id}-trigger`}
        type="button"
        className={iconOnly ? styles.iconChip : styles.chip}
        data-active={active ? '' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={iconOnly ? String(ariaLabel ?? label) : ariaLabel}
        title={iconOnly ? String(ariaLabel ?? label) : undefined}
        onClick={() => setOpen(!open)}
        data-testid={testId}
      >
        {icon && <Icon icon={icon} size={14} aria-hidden />}
        {!iconOnly && <span className={styles.chipText}>{label}</span>}
        {!iconOnly && <Icon icon={ChevronDown} size={12} aria-hidden />}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={panelLabel}
          className={styles.pop}
          data-align={align}
          style={minWidth ? { minWidth } : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
          data-testid={testId ? `${testId}-panel` : undefined}
        >
          {children(close)}
        </div>
      )}
    </span>
  );
};

export interface MultiOption {
  value: string;
  label: string;
  count?: number;
  /** 品牌图标 id（模型厂商） */
  brand?: string;
}

/** 弹层里的多选列表：搜索 + 复选；选项多于 8 个时显示搜索框 */
export const MultiSelect: React.FC<{
  options: MultiOption[];
  value: string[];
  onChange: (v: string[]) => void;
  label: string;
  testId?: string;
}> = ({ options, value, onChange, label, testId }) => {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.label.toLowerCase().includes(s)) : options;
  }, [options, q]);
  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className={styles.multi} data-testid={testId}>
      {options.length > 8 && (
        <Input
          size="sm"
          value={q}
          placeholder={t('ui.knowledge-local.search-f04090')}
          aria-label={t('ui.model-quality.search', label)}
          onChange={(e) => setQ(e.target.value)}
          data-testid={testId ? `${testId}-search` : undefined}
        />
      )}
      {options.length === 0 ? (
        <p className={styles.popHint}>{t('ui.model-quality.no-data-in-this-range')}</p>
      ) : (
        <ul className={styles.optList} role="listbox" aria-multiselectable aria-label={label}>
          {list.map((o) => {
            const on = value.includes(o.value);
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={styles.opt}
                  onClick={() => toggle(o.value)}
                  data-testid={testId ? `${testId}-opt` : undefined}
                >
                  <span className={styles.check} data-on={on ? '' : undefined} aria-hidden>
                    {on && <Icon icon={Check} size={11} />}
                  </span>
                  {o.brand !== undefined && <BrandIcon brand={o.brand} name={o.label} size={16} />}
                  <span className={styles.optLabel}>{o.label}</span>
                  {o.count != null && <span className={styles.optCount}>{o.count}</span>}
                </button>
              </li>
            );
          })}
          {list.length === 0 && (
            <li className={styles.popHint}>{t('ui.model-quality.no-matches')}</li>
          )}
        </ul>
      )}
      {value.length > 0 && (
        <div className={styles.popFoot}>
          <button type="button" className={styles.textBtn} onClick={() => onChange([])}>
            {t('ui.model-quality.clear-selection')}
          </button>
        </div>
      )}
    </div>
  );
};

/** 弹层里的单选菜单（层级预设等） */
export const RadioMenu = <T extends string>({
  options,
  value,
  onChange,
  label,
  testId,
}: {
  options: Array<{ value: T; label: string; hint?: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  testId?: string;
}) => (
  <div role="menu" aria-label={label} className={styles.optList} data-testid={testId}>
    {options.map((o) => (
      <button
        key={o.value}
        type="button"
        role="menuitemradio"
        aria-checked={o.value === value}
        className={styles.opt}
        onClick={() => onChange(o.value)}
        data-testid={testId ? `${testId}-${o.value}` : undefined}
      >
        <span className={styles.radio} data-on={o.value === value ? '' : undefined} aria-hidden />
        <span className={styles.optLabel}>
          {o.label}
          {o.hint && <small className={styles.optHint}>{o.hint}</small>}
        </span>
      </button>
    ))}
  </div>
);
