/**
 * 统一的模型选择器（docs/design/unified-gateway.md §4.4）：所有选第三方模型的地方都用它。
 * - 按供应商分组，模型旁显示能力（推理、视觉、上下文长度）；可选的「最近使用」分组置顶；
 * - 给编程助手选（purpose="coding"）时，不支持工具调用的模型不出现，参数未知的标出来；
 * - 搜索支持 `provider/` 前缀过滤；键盘与弹层行为沿用 Select。
 * 值的格式是 `providerId/modelId`（模型 id 本身可以含 `/`，供应商 id 不含）。
 */
import React, { useMemo } from 'react';

import { t } from './i18n';
import { Select, type SelectOption, type SelectProps } from './Select';

export interface PickerModel {
  id: string;
  /** 显示名（默认用 id） */
  label?: string;
  /** 上下文窗口（token） */
  ctx?: number;
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
  models: PickerModel[];
}

export interface ModelPickerProps extends Pick<
  SelectProps,
  'size' | 'variant' | 'disabled' | 'menuMinWidth' | 'className' | 'id'
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
  placeholder?: string;
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
  placeholder,
  ...rest
}) => {
  const { options, display } = useMemo(() => {
    const usable = (m: PickerModel) => purpose !== 'coding' || m.toolCalling !== false;
    const byRef = new Map<string, { p: PickerProvider; m: PickerModel }>();
    for (const p of providers)
      for (const m of p.models) if (usable(m)) byRef.set(`${p.id}/${m.id}`, { p, m });
    const display = new Map<string, string>();
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
        display.set(ref, `${p.name} / ${m.label ?? m.id}`);
        const caps = capabilities(m, purpose);
        opts.push({
          value: ref,
          group: p.name,
          label: m.label ?? m.id,
          // 能力（推理 · 视觉 …）只放悬停提示：选项行留给模型名，避免被截断
          ...(caps ? { hint: caps } : {}),
          ...(showWire && m.wire ? { description: m.wire } : {}),
          searchText: `${p.id}/${m.id} ${p.name} ${m.label ?? ''}`,
        });
      }
    }
    return { options: opts, display };
  }, [providers, recent, purpose, showWire, extraOptions]);

  return (
    <Select
      {...rest}
      searchable
      options={options}
      value={value ?? ''}
      placeholder={placeholder ?? t('ui.models.choose-a-model')}
      menuMinWidth={rest.menuMinWidth ?? 300}
      // 特殊选项的 label 可以是翻译 key（与 Select 一致）
      renderValue={(o) => display.get(o.value) ?? t(o.label)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};
