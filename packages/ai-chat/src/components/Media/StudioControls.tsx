/**
 * 工作台通用控件：按 schema 渲染的参数字段（分段 / 下拉 / 滑块 / 开关 / 文本）与带图标的下拉菜单。
 * 只渲染当前模型 schema 给出的字段与取值，不在这里写死任何模型参数。
 */
import type { ParamValue, ResolvedField } from '@nomi-ai/gateway/media';
import { Icon, Input, Select, Switch, t } from '@nomi-ai/ui';
import { Check, ChevronDown } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import styles from './Studio.module.css';
import { segmentOptions } from './studioModel';

export const label = (k: string) => (k.startsWith('ui.') ? t(k) : k);

export const StudioField: React.FC<{
  f: ResolvedField;
  value: ParamValue | undefined;
  onChange: (v: ParamValue | undefined) => void;
}> = ({ f, value, onChange }) => {
  const ui = f['x-ui'];
  const name = label(ui.label);
  const optLabel = (v: ParamValue) => label(ui.optionLabels?.[String(v)] ?? String(v));
  const segs = segmentOptions(f);
  let control: React.ReactNode;
  if (ui.control === 'switch' || f.type === 'boolean') {
    return (
      <div className={styles.fieldInline}>
        <span className={styles.fieldLabel}>{name}</span>
        <Switch checked={value === true} onChange={(v) => onChange(v)} aria-label={name} />
      </div>
    );
  } else if (segs) {
    control = (
      <div
        className={styles.segmented}
        role="radiogroup"
        aria-label={name}
        style={{ gridTemplateColumns: `repeat(${Math.min(segs.length, 5)}, minmax(0, 1fr))` }}
      >
        {segs.map((v) => (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={value === v}
            className={`${styles.segment} ${value === v ? styles.segmentOn : ''}`}
            onClick={() => onChange(v)}
          >
            {optLabel(v)}
          </button>
        ))}
      </div>
    );
  } else if (f.enum) {
    control = (
      <Select
        size="sm"
        value={String(value ?? '')}
        options={f.enum.map((v) => ({ value: String(v), label: optLabel(v) }))}
        onChange={(e) => onChange(f.enum!.find((v) => String(v) === e.target.value))}
        aria-label={name}
      />
    );
  } else if (
    (f.type === 'integer' || f.type === 'number') &&
    typeof f.minimum === 'number' &&
    typeof f.maximum === 'number'
  ) {
    const step = ui.step ?? (f.type === 'integer' ? 1 : 0.1);
    control = (
      <div className={styles.slider}>
        <input
          type="range"
          min={f.minimum}
          max={f.maximum}
          step={step}
          value={typeof value === 'number' ? value : f.minimum}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={name}
        />
        <span className={styles.sliderValue}>{value === undefined ? '–' : String(value)}</span>
      </div>
    );
  } else {
    control = (
      <Input
        size="sm"
        type={f.type === 'string' ? 'text' : 'number'}
        value={value === undefined ? '' : String(value)}
        onChange={(e) =>
          onChange(
            e.target.value === ''
              ? undefined
              : f.type === 'string'
                ? e.target.value
                : Number(e.target.value),
          )
        }
        aria-label={name}
      />
    );
  }
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{name}</span>
      {control}
    </div>
  );
};

export interface MenuItem {
  value: string;
  title: string;
  description?: string;
  badge?: string;
  /** 能力标签（如 文生图 / 图生图），以小标签显示 */
  tags?: string[];
  disabled?: boolean;
}

const Tags: React.FC<{ tags?: string[] }> = ({ tags }) =>
  tags?.length ? (
    <span className={styles.tags}>
      {tags.map((x) => (
        <span key={x} className={styles.tag}>
          {x}
        </span>
      ))}
    </span>
  ) : null;

/** 带图标的下拉：触发器显示当前项（图标 + 名称 + 徽标 + 一行说明），列表同样式 */
export const IconMenu: React.FC<{
  items: MenuItem[];
  value: string;
  onChange: (v: string) => void;
  icon: React.ReactNode;
  ariaLabel: string;
  placeholder?: string;
  compact?: boolean;
  disabled?: boolean;
  testId?: string;
  up?: boolean;
}> = ({ items, value, onChange, icon, ariaLabel, placeholder, compact, disabled, testId, up }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const cur = items.find((i) => i.value === value);
  return (
    <div className={styles.menuWrap} ref={ref}>
      <button
        type="button"
        className={compact ? styles.pill : styles.menuTrigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        data-testid={testId}
      >
        {!compact && <span className={styles.menuIcon}>{icon}</span>}
        <span className={styles.menuText}>
          <span className={styles.menuTitle}>
            {cur?.title ?? placeholder}
            {!compact && cur?.badge && <span className={styles.badge}>{cur.badge}</span>}
          </span>
          {!compact && cur?.description && (
            <span className={styles.menuDesc}>{cur.description}</span>
          )}
          {!compact && <Tags tags={cur?.tags} />}
        </span>
        <Icon icon={ChevronDown} size={compact ? 12 : 16} />
      </button>
      {open && (
        <div className={`${styles.menuList} ${up ? styles.menuUp : ''}`} role="listbox">
          {items.map((i) => (
            <button
              key={i.value}
              type="button"
              role="option"
              aria-selected={i.value === value}
              disabled={i.disabled}
              className={`${styles.menuItem} ${i.value === value ? styles.menuItemOn : ''}`}
              onClick={() => {
                onChange(i.value);
                setOpen(false);
              }}
            >
              <span className={styles.menuIcon}>{icon}</span>
              <span className={styles.menuText}>
                <span className={styles.menuTitle}>
                  {i.title}
                  {i.badge && <span className={styles.badge}>{i.badge}</span>}
                </span>
                {i.description && <span className={styles.menuDesc}>{i.description}</span>}
                <Tags tags={i.tags} />
              </span>
              {i.value === value && <Icon icon={Check} size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
