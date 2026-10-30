/**
 * 模型列表的浏览控件：顶部按供应商分标签、右侧按厂商（OpenAI、Anthropic …）快速筛选。
 * ModelPicker（browse）与编程助手的模型按钮共用，外观与交互一致。
 */
import { Ellipsis, LayoutGrid } from 'lucide-react';
import React from 'react';

import { BrandIcon } from './BrandIcon';
import { cx } from './cx';
import { t } from './i18n';
import { Icon } from './icons';
import { modelVendorOf, modelVendorRank } from './modelVendor';

/** 认不出厂商的模型归到这一组 */
export const OTHER_VENDOR = '';

export interface ModelVendorChip {
  id: string;
  name: string;
  brand?: string;
  count: number;
}

/** 模型 id → 厂商 id（认不出是 OTHER_VENDOR） */
export function modelVendorId(modelId: string): string {
  return modelVendorOf(modelId)?.id ?? OTHER_VENDOR;
}

/** 一组模型里出现的厂商，按常见程度排序，「其他厂商」最后 */
export function modelVendors(modelIds: Iterable<string>): ModelVendorChip[] {
  const seen = new Map<string, ModelVendorChip>();
  for (const id of modelIds) {
    const v = modelVendorOf(id);
    const key = v?.id ?? OTHER_VENDOR;
    const hit = seen.get(key);
    if (hit) hit.count++;
    else
      seen.set(
        key,
        v
          ? { id: v.id, name: v.name, brand: v.brand, count: 1 }
          : { id: OTHER_VENDOR, name: t('ui.models.other-vendors'), count: 1 },
      );
  }
  return [...seen.values()].sort(
    (a, b) =>
      (a.id === OTHER_VENDOR ? 1 : 0) - (b.id === OTHER_VENDOR ? 1 : 0) ||
      modelVendorRank(a.id) - modelVendorRank(b.id),
  );
}

/** 点标签 / 厂商时不抢走搜索框的焦点 */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

export interface ModelProviderTab {
  id: string;
  name: string;
  /** 悬停说明（如「本会话原来的供应商」） */
  hint?: string;
}

export const ModelProviderTabs: React.FC<{
  tabs: ModelProviderTab[];
  value: string;
  onChange: (id: string) => void;
}> = ({ tabs, value, onChange }) => (
  <div
    className="cd-model-picker__tabs"
    role="tablist"
    aria-label={t('ui.models.filter-by-provider')}
  >
    {tabs.map((p) => (
      <button
        key={p.id}
        type="button"
        role="tab"
        aria-selected={value === p.id}
        className={cx('cd-model-picker__tab', value === p.id && 'is-active')}
        title={p.hint}
        onMouseDown={keepFocus}
        onClick={() => onChange(p.id)}
        data-testid={`model-picker-tab-${p.id}`}
      >
        <span className="cd-truncate">{p.name}</span>
      </button>
    ))}
  </div>
);

/**
 * 左侧厂商筛选栏，只显示图标（名字在悬停提示与 aria-label 里）；
 * value null = 全部厂商，再点一次已选的厂商也回到全部
 */
export const ModelVendorFilter: React.FC<{
  vendors: ModelVendorChip[];
  value: string | null;
  onChange: (id: string | null) => void;
}> = ({ vendors, value, onChange }) => (
  <div
    className="cd-model-picker__vendors"
    role="group"
    aria-label={t('ui.models.filter-by-vendor')}
  >
    {[{ id: null, name: t('ui.models.all-vendors'), brand: undefined }, ...vendors].map((v) => {
      const on = value === v.id;
      return (
        <button
          key={v.id ?? '*'}
          type="button"
          aria-pressed={on}
          aria-label={v.name}
          title={v.name}
          className={cx('cd-model-picker__vendor', on && 'is-active')}
          onMouseDown={keepFocus}
          onClick={() => onChange(on ? null : v.id)}
          data-testid={`model-picker-vendor-${v.id ?? 'all'}`}
        >
          {v.id === null ? (
            <Icon icon={LayoutGrid} size={16} />
          ) : (
            <BrandIcon
              brand={v.brand}
              name={v.name}
              size={20}
              fallbackIcon={v.id === OTHER_VENDOR ? Ellipsis : undefined}
            />
          )}
        </button>
      );
    })}
  </div>
);
