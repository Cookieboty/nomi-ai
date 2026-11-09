/**
 * 统一的模型选择器（docs/development/gateway.md）：所有选第三方模型的地方都用它。
 * - 按供应商分组，模型旁显示能力（推理、视觉、上下文长度）；可选的「最近使用」分组置顶；
 * - 给编程助手选（purpose="coding"）时，不支持工具调用的模型不出现，参数未知的标出来；
 * - 搜索支持 `provider/` 前缀过滤；键盘与弹层行为沿用 Select；
 * - browse：弹层顶部按供应商分标签、左侧按厂商（OpenAI、Anthropic …）快速筛选（对话输入栏用）；
 * - inline：菜单直接画在调用方的浮层里（编程助手「模型 · 思考深度」浮层的模型页），与 Nomi 对话的下拉同一个组件。
 * 值的格式是 `providerId/modelId`（模型 id 本身可以含 `/`，供应商 id 不含）。
 */
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { BrandIcon } from './BrandIcon';
import { t } from './i18n';
import { ModelProviderTabs, modelVendorId, modelVendors, ModelVendorFilter } from './ModelBrowse';
import { modelBrandOf } from './modelVendor';
import { Select, type SelectOption, type SelectProps } from './Select';

export interface PickerModel {
  id: string;
  /** 显示名（默认用 id） */
  label?: string;
  /** 上下文窗口（token） */
  ctx?: number;
  /** 分档计价模型的标准窗口：browse 行右侧显示「标准 / 上下文」 */
  ctxStandard?: number;
  reasoning?: boolean;
  vision?: boolean;
  /** false：不支持工具调用（编程助手不能用） */
  toolCalling?: boolean;
  /** false：上下文 / 输出上限是默认值，没有查证过 */
  metaKnown?: boolean;
  /** 「高级显示」时右侧显示的协议（如 Chat、Anthropic） */
  wire?: string;
}

export interface PickerProvider {
  id: string;
  name: string;
  /** browse 时供应商标签的悬停说明（如「默认供应商」「会话原来的供应商」） */
  hint?: string;
  /** false：这个供应商的模型都是同一家（如编程助手自己的官方模型），不显示厂商筛选 */
  vendors?: boolean;
  /** 供应商的品牌图标 id（预设 id）：模型认不出厂商时用它的图标 */
  brand?: string;
  models: PickerModel[];
}

export interface ModelPickerProps extends Pick<
  SelectProps,
  | 'size'
  | 'variant'
  | 'disabled'
  | 'menuMinWidth'
  | 'className'
  | 'id'
  | 'inline'
  | 'inlineMaxHeight'
  | 'defaultQuery'
  | 'onOpenChange'
> {
  providers: PickerProvider[];
  /** 最近使用（`providerId/modelId`），最多显示 5 个 */
  recent?: string[];
  value: string | null;
  onChange: (ref: string) => void;
  /** coding：给编程助手选，过滤不支持工具调用的模型 */
  purpose?: 'chat' | 'coding';
  /** 高级显示：右侧带协议标签 */
  showWire?: boolean;
  /** 放在最前面的特殊选项（如「跟随对话」「未设置」），值不能含 `/` */
  extraOptions?: SelectOption[];
  /** 放在最后的特殊选项（如「切换到官方账号」一组），值不能含 `/`；不受供应商标签 / 厂商筛选影响 */
  tailOptions?: SelectOption[];
  /** 弹层顶部最上面的提示（如读不到模型列表的原因） */
  notice?: React.ReactNode;
  /** 顶部供应商标签那一行的右端（如刷新按钮）；没有标签时单独一行 */
  headerEnd?: React.ReactNode;
  /** 触发器只写模型名，不带「供应商 /」（只有一个来源时，如内置的已知模型目录） */
  modelOnly?: boolean;
  /** 当前值不是哪个供应商的模型（如「默认模型」）时，打开停在这个供应商的标签（如默认模型所在的供应商） */
  focusProvider?: string;
  /** 模型行的 data-testid（按值），特殊选项用它们自己的 testId */
  optionTestId?: (ref: string) => string | undefined;
  placeholder?: string;
  /** 弹层顶部按供应商分标签、右侧按厂商筛选（供应商 / 厂商多于一个时才出现） */
  browse?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
}

const RECENT_MAX = 5;

/** 截断到 digits 位小数（抹零，不四舍五入：1,050,000 → 1M，不显示成 1.1M） */
export function truncDigits(x: number, digits: number): string {
  const f = 10 ** digits;
  // 1e-9 抵消浮点误差（0.29 * 100 = 28.999…）
  return String(Math.floor(x * f + 1e-9) / f);
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${truncDigits(tokens / 1_000_000, 1)}M`;
  if (tokens >= 1000) return `${truncDigits(tokens / 1000, 0)}K`;
  return String(Math.floor(tokens));
}

/** 能力标签：推理 · 视觉 · 128K；参数未知时给编程助手的提示 */
function capabilities(m: PickerModel, purpose: 'chat' | 'coding'): string {
  const parts: string[] = [];
  if (m.reasoning) parts.push(t('ui.models.reasoning'));
  if (m.vision) parts.push(t('ui.models.vision'));
  if (m.ctx) parts.push(formatContext(m.ctx));
  if (purpose === 'coding' && m.metaKnown === false) parts.push(t('ui.models.limits-unknown'));
  return parts.join(' · ');
}

/** 模型名去掉厂商前缀：google/gemini-2.5-flash-image → gemini-2.5-flash-image */
export const shortModelName = (s: string): string => s.slice(s.lastIndexOf('/') + 1);

export function splitModelRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf('/');
  return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : null;
}

/** 默认值用模块级常量：参数默认值里的 [] 每次渲染都是新数组，会让下面的 useMemo 每次都重算 */
const NO_RECENT: string[] = [];
const NO_EXTRA: SelectOption[] = [];

export const ModelPicker: React.FC<ModelPickerProps> = ({
  providers,
  recent = NO_RECENT,
  value,
  onChange,
  purpose = 'chat',
  showWire = false,
  extraOptions = NO_EXTRA,
  tailOptions = NO_EXTRA,
  notice,
  headerEnd,
  optionTestId,
  focusProvider,
  modelOnly = false,
  placeholder,
  browse = false,
  onOpenChange: onOpenChangeProp,
  ...rest
}) => {
  const { options, display, meta, brands } = useMemo(() => {
    const usable = (m: PickerModel) => purpose !== 'coding' || m.toolCalling !== false;
    const byRef = new Map<string, { p: PickerProvider; m: PickerModel }>();
    for (const p of providers)
      for (const m of p.models) if (usable(m)) byRef.set(`${p.id}/${m.id}`, { p, m });
    const display = new Map<string, string>();
    /** ref → 品牌图标 id：只画在按钮上，列表行不带（左侧已有厂商筛选） */
    const brands = new Map<string, string>();
    /** ref → 供应商 id、模型 id 与厂商 id（browse 筛选用） */
    const meta = new Map<string, { provider: string; model: string; vendor: string }>();
    const opts: SelectOption[] = [...extraOptions];
    const recentGroup = t('ui.cli-monitor.recent');
    for (const ref of recent.filter((r) => byRef.has(r)).slice(0, RECENT_MAX)) {
      const { p, m } = byRef.get(ref)!;
      opts.push({
        value: ref,
        group: recentGroup,
        label: `${p.name} / ${m.label ?? m.id}`,
        description: showWire ? m.wire : undefined,
        searchText: `${p.id}/${m.id} ${p.name} ${m.label ?? ''}`,
      });
    }
    for (const p of providers) {
      for (const m of p.models) {
        if (!usable(m)) continue;
        const ref = `${p.id}/${m.id}`;
        display.set(ref, modelOnly ? (m.label ?? m.id) : `${p.name} / ${m.label ?? m.id}`);
        meta.set(ref, { provider: p.id, model: m.id, vendor: modelVendorId(m.id) });
        const caps = capabilities(m, purpose);
        const name = m.label ?? m.id;
        const brand = modelBrandOf(m.id, p.brand);
        if (brand) brands.set(ref, brand);
        opts.push({
          value: ref,
          group: p.name,
          // browse：去掉厂商前缀（左侧已有厂商筛选与分组标题），完整 id 照样能搜到
          label: browse ? shortModelName(name) : name,
          // 能力（推理 · 视觉 …）只放悬停提示：选项行留给模型名，避免被截断
          ...(caps ? { hint: caps } : {}),
          ...(showWire && m.wire
            ? { description: m.wire }
            : browse && m.ctx
              ? {
                  description: m.ctxStandard
                    ? `${formatContext(m.ctxStandard)} / ${formatContext(m.ctx)}`
                    : formatContext(m.ctx),
                }
              : {}),
          searchText: `${p.id}/${m.id} ${p.name} ${m.label ?? ''}`,
          ...(optionTestId?.(ref) ? { testId: optionTestId(ref) } : {}),
        });
      }
    }
    opts.push(...tailOptions);
    return { options: opts, display, meta, brands };
  }, [
    providers,
    recent,
    purpose,
    showWire,
    extraOptions,
    tailOptions,
    browse,
    optionTestId,
    modelOnly,
  ]);

  const tabs = useMemo(
    () => providers.filter((p) => [...meta.values()].some((x) => x.provider === p.id)),
    [providers, meta],
  );
  /** 打开时停在哪个供应商标签：当前值所在的那个，没有就第一个；只有一个供应商时不分标签 */
  const initialTab = () =>
    tabs.length > 1
      ? ((value ? meta.get(value)?.provider : undefined) ??
        tabs.find((p) => p.id === focusProvider)?.id ??
        tabs[0].id)
      : '';
  // browse：当前供应商标签（'' = 不按供应商筛，只有一个供应商时）与厂商筛选（null = 全部）；
  // inline 没有「打开」这一刻，挂载时就定位
  const [tab, setTab] = useState(() => (browse && rest.inline ? initialTab() : ''));
  const [vendor, setVendor] = useState<string | null>(null);
  const vendors = useMemo(
    () =>
      modelVendors(
        [...meta.values()].filter((x) => !tab || x.provider === tab).map((x) => x.model),
      ),
    [meta, tab],
  );
  const showTabs = browse && tabs.length > 1;
  // 当前标签（只有一个供应商时就是它）声明了不按厂商筛选
  const tabProvider = tab
    ? tabs.find((p) => p.id === tab)
    : tabs.length === 1
      ? tabs[0]
      : undefined;
  const showVendors = browse && vendors.length > 1 && tabProvider?.vendors !== false;
  // 切到的标签里没有这个厂商：回到全部
  const activeVendor = vendor !== null && vendors.some((v) => v.id === vendor) ? vendor : null;

  const recentGroup = t('ui.cli-monitor.recent');
  const tailValues = useMemo(() => new Set(tailOptions.map((o) => o.value)), [tailOptions]);
  const filterOption = useMemo(() => {
    if (!browse || (!tab && activeVendor === null)) return undefined;
    return (o: SelectOption) => {
      const x = meta.get(o.value);
      // 特殊选项（跟随对话等）始终在；分了供应商标签时不列最近使用
      if (!x) return !o.value.includes('/');
      if (o.group === recentGroup) return false;
      return (!tab || x.provider === tab) && (activeVendor === null || x.vendor === activeVendor);
    };
  }, [browse, tab, activeVendor, meta, recentGroup]);

  // 打开时定位到当前值所在的供应商，厂商筛选清空
  const initialTabRef = useRef(initialTab);
  initialTabRef.current = initialTab;
  const onOpenChange = useCallback(
    (open: boolean) => {
      onOpenChangeProp?.(open);
      if (!open || !browse) return;
      setTab(initialTabRef.current());
      setVendor(null);
    },
    [browse, onOpenChangeProp],
  );
  // inline：供应商在挂载之后才到（如网关状态晚一步）时补一次定位
  useLayoutEffect(() => {
    if (!browse || !rest.inline || tab || tabs.length < 2) return;
    setTab(initialTabRef.current());
  }, [browse, rest.inline, tab, tabs.length]);

  // 分了供应商标签时列表里不再重复供应商分组标题；「全部厂商」时改按厂商分组（顺序与左侧图标栏一致）
  const listOptions = useMemo(() => {
    const vendorGrouped = showVendors && activeVendor === null;
    if (!showTabs && !vendorGrouped) return options;
    const rank = new Map(vendors.map((v, i) => [v.id, i]));
    const name = new Map(vendors.map((v) => [v.id, v.name]));
    const mapped = options.map((o) => {
      const x = meta.get(o.value);
      if (!x || o.group === recentGroup) return o;
      return { ...o, group: vendorGrouped ? name.get(x.vendor) : undefined };
    });
    if (!vendorGrouped) return mapped;
    // 特殊选项、最近使用在前，其余按厂商顺序（同厂商内保持原顺序）
    const key = (o: SelectOption) => {
      const x = meta.get(o.value);
      if (tailValues.has(o.value)) return Number.MAX_SAFE_INTEGER;
      if (!x) return -2;
      if (o.group === recentGroup) return -1;
      return rank.get(x.vendor) ?? vendors.length;
    };
    return mapped
      .map((o, i) => ({ o, i, k: key(o) }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map((x) => x.o);
  }, [showTabs, showVendors, activeVendor, vendors, options, meta, recentGroup, tailValues]);

  const tabsRow =
    showTabs || headerEnd ? (
      <div className="cd-model-picker__header">
        {showTabs ? (
          <ModelProviderTabs
            tabs={tabs}
            value={tab}
            onChange={(id) => {
              setTab(id);
              setVendor(null);
            }}
          />
        ) : (
          <span className="cd-model-picker__header-fill" />
        )}
        {headerEnd}
      </div>
    ) : null;
  const menuHeader =
    notice || tabsRow ? (
      <>
        {notice}
        {tabsRow}
      </>
    ) : null;
  const menuAside = showVendors ? (
    <ModelVendorFilter vendors={vendors} value={activeVendor} onChange={setVendor} />
  ) : null;

  return (
    <Select
      {...rest}
      searchable
      options={listOptions}
      value={value ?? ''}
      placeholder={placeholder ?? t('ui.models.choose-a-model')}
      menuMinWidth={rest.menuMinWidth ?? (showVendors ? 380 : showTabs ? 340 : 300)}
      menuHeader={menuHeader}
      menuAside={menuAside}
      filterOption={filterOption}
      onOpenChange={onOpenChange}
      // 特殊选项的 label 可以是翻译 key（与 Select 一致）
      renderValue={(o) => display.get(o.value) ?? t(o.label)}
      valueIcon={(o) => {
        const brand = brands.get(o.value);
        return brand ? (
          <BrandIcon brand={brand} name={display.get(o.value) ?? o.value} size={14} />
        ) : null;
      }}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};
