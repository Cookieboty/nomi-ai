/**
 * 模型质量的工具栏（一行，窄时换行）：时间范围、口径层、层级、筛选芯片；右侧「口径」、刷新、导出、设置。
 * 有筛选时下面一行列出可移除的筛选与「清除全部」。所有控件同一高度（--cd-control-h-sm）。
 */
import { Icon, Input, SegmentedControl, Switch, Tooltip, t } from '@nomi-ai/ui';
import {
  CalendarRange,
  Download,
  Info,
  Layers,
  RefreshCw,
  Ruler,
  Settings2,
  X,
} from 'lucide-react';
import React from 'react';

import type { QualityFacets, QualityLayer, QualityOutcome } from '../../services/qualityClient';

import {
  HIERARCHIES,
  brandOfVendor,
  clientLabel,
  formatDay,
  fromDateInput,
  hierarchyLabel,
  outcomeLabel,
  toDateInput,
  type HierarchyId,
  type RangeId,
} from './format';
import styles from './index.module.css';
import { MultiSelect, Popover, RadioMenu, type MultiOption } from './Popover';
import { QualitySettingsPanel } from './Settings';
import type { CountOptions, FilterDim, Filters } from './types';

const FILTER_DIMS: Array<{
  dim: Exclude<FilterDim, 'outcome'>;
  label: string;
  gatewayOnly?: boolean;
}> = [
  { dim: 'client', label: '客户端' },
  { dim: 'provider', label: '供应商' },
  { dim: 'modelFamily', label: '模型' },
  { dim: 'key', label: 'Key', gatewayOnly: true },
];

const dimLabel = (d: FilterDim): string =>
  d === 'outcome' ? t('结果') : t(FILTER_DIMS.find((x) => x.dim === d)?.label ?? d);

/** 筛选值的显示名：客户端本地化，其余用筛选项给的名字 */
export function valueLabel(dim: FilterDim, key: string, facets: QualityFacets | null): string {
  if (dim === 'client') return clientLabel(key);
  if (dim === 'outcome') return outcomeLabel(key as QualityOutcome);
  return facets?.[dim]?.find((f) => f.key === key)?.label ?? key;
}

export interface ToolbarProps {
  rangeId: RangeId;
  onRange: (id: RangeId) => void;
  custom: { from: number; to: number };
  onCustom: (r: { from: number; to: number }) => void;
  layer: QualityLayer;
  onLayer: (l: QualityLayer) => void;
  hierarchy: HierarchyId;
  onHierarchy: (h: HierarchyId) => void;
  /** 当前标签页用不到层级（请求明细 / 趋势）时不显示 */
  showHierarchy: boolean;
  filters: Filters;
  onFilters: (f: Filters) => void;
  facets: QualityFacets | null;
  count: CountOptions;
  onCount: (c: CountOptions) => void;
  onRefresh: () => void;
  /** 当前标签页可导出时给 */
  onExport?: () => void;
  onOpenPrivacy?: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = (p) => {
  const [customOpen, setCustomOpen] = React.useState(false);
  const gateway = p.layer === 'gateway';

  const optionsOf = (dim: Exclude<FilterDim, 'outcome'>): MultiOption[] =>
    (p.facets?.[dim] ?? []).map((f) => ({
      value: f.key,
      label: dim === 'client' ? clientLabel(f.key) : f.label,
      count: f.count,
      ...(dim === 'modelFamily' ? { brand: brandOfVendor(f.vendor) ?? '' } : {}),
    }));

  const chipLabel = (dim: Exclude<FilterDim, 'outcome'>, label: string) => {
    const v = p.filters[dim] ?? [];
    if (!v.length) return t(label);
    const first = valueLabel(dim, v[0]!, p.facets);
    return v.length > 1
      ? t('{0}：{1} +{2}', t(label), first, v.length - 1)
      : `${t(label)}：${first}`;
  };

  const set = (dim: FilterDim, v: string[]) => p.onFilters({ ...p.filters, [dim]: v });

  const active = (Object.entries(p.filters) as Array<[FilterDim, string[] | undefined]>).filter(
    ([d, v]) => v?.length && (gateway || d !== 'key'),
  ) as Array<[FilterDim, string[]]>;

  return (
    <div className={styles.toolbarWrap}>
      <div className={styles.toolbar} role="toolbar" aria-label={t('统计范围与筛选')}>
        <SegmentedControl<RangeId>
          aria-label={t('统计时间范围')}
          data-testid="quality-range"
          value={p.rangeId}
          onChange={(v) => {
            p.onRange(v);
            if (v === 'custom') setCustomOpen(true);
          }}
          options={[
            { value: 'today', label: t('今天') },
            { value: '7d', label: t('7 天') },
            { value: '30d', label: t('30 天') },
            { value: 'custom', label: t('自定义'), testId: 'quality-range-custom' },
          ]}
        />
        {p.rangeId === 'custom' && (
          <Popover
            label={`${formatDay(p.custom.from)} – ${formatDay(p.custom.to)}`}
            ariaLabel={t('自定义日期范围')}
            icon={CalendarRange}
            panelLabel={t('自定义日期范围')}
            open={customOpen}
            onOpenChange={setCustomOpen}
            testId="quality-custom"
          >
            {() => (
              <div className={styles.dateRow}>
                <label className={styles.popField}>
                  <span>{t('开始')}</span>
                  <Input
                    size="sm"
                    type="date"
                    data-testid="quality-from"
                    value={toDateInput(p.custom.from)}
                    onChange={(e) => {
                      const v = fromDateInput(e.target.value);
                      if (v != null && v <= p.custom.to) p.onCustom({ ...p.custom, from: v });
                    }}
                  />
                </label>
                <label className={styles.popField}>
                  <span>{t('结束')}</span>
                  <Input
                    size="sm"
                    type="date"
                    data-testid="quality-to"
                    value={toDateInput(p.custom.to)}
                    onChange={(e) => {
                      const v = fromDateInput(e.target.value, true);
                      if (v != null && v >= p.custom.from) p.onCustom({ ...p.custom, to: v });
                    }}
                  />
                </label>
              </div>
            )}
          </Popover>
        )}
        <span className={styles.layerGroup}>
          <SegmentedControl<QualityLayer>
            aria-label={t('测量口径')}
            data-testid="quality-layer"
            value={p.layer}
            onChange={p.onLayer}
            options={[
              { value: 'gateway', label: t('网关层'), testId: 'quality-layer-gateway' },
              { value: 'cli', label: t('CLI 层'), testId: 'quality-layer-cli' },
            ]}
          />
          <Tooltip
            placement="bottom-start"
            content={
              <span className={styles.tipBody}>
                <b>{t('网关层')}</b>
                {t(
                  '经 Nomi 统一网关的每个 HTTP 请求（Nomi 对话、编程助手的第三方供应商），有首字节、Key、回退等细节，最精确。',
                )}
                <b>{t('CLI 层')}</b>
                {t(
                  'Nomi 里运行的编程助手（官方账号与第三方都有），按每一轮计，时间含 CLI 自身与工具执行的开销，没有 Key。',
                )}
                <span>{t('在终端里直接使用的 CLI 不经过 Nomi，不在统计范围内。')}</span>
              </span>
            }
          >
            <button type="button" className={styles.infoBtn} aria-label={t('两种测量口径的区别')}>
              <Icon icon={Info} size={14} />
            </button>
          </Tooltip>
        </span>
        {p.showHierarchy && (
          <Popover
            label={hierarchyLabel(p.hierarchy, p.layer)}
            ariaLabel={t('层级：{0}', hierarchyLabel(p.hierarchy, p.layer))}
            icon={Layers}
            panelLabel={t('对比表的层级')}
            testId="quality-hierarchy"
            minWidth={220}
          >
            {(close) => (
              <RadioMenu<HierarchyId>
                label={t('对比表的层级')}
                value={p.hierarchy}
                testId="quality-hierarchy-menu"
                onChange={(v) => {
                  p.onHierarchy(v);
                  close();
                }}
                options={HIERARCHIES.map((h) => ({
                  value: h.id,
                  label: hierarchyLabel(h.id, p.layer),
                  hint:
                    h.id === 'model-provider-key'
                      ? t('同一模型在不同供应商、不同 Key 上的差别')
                      : h.id === 'model-client-provider'
                        ? t('同一模型在不同编程助手里的差别')
                        : h.id === 'client-model-provider'
                          ? t('每个编程助手各用了哪些模型')
                          : t('每个供应商各提供了哪些模型'),
                }))}
              />
            )}
          </Popover>
        )}
        {FILTER_DIMS.filter((d) => gateway || !d.gatewayOnly).map((d) => (
          <Popover
            key={d.dim}
            label={chipLabel(d.dim, d.label)}
            active={!!p.filters[d.dim]?.length}
            panelLabel={t('按{0}筛选', t(d.label))}
            testId={`quality-filter-${d.dim}`}
            minWidth={240}
          >
            {() => (
              <MultiSelect
                label={t(d.label)}
                options={optionsOf(d.dim)}
                value={p.filters[d.dim] ?? []}
                onChange={(v) => set(d.dim, v)}
                testId={`quality-filter-${d.dim}-list`}
              />
            )}
          </Popover>
        ))}
        <span className={styles.toolbarEnd}>
          <Popover
            label={t('口径')}
            icon={Ruler}
            align="end"
            panelLabel={t('统计口径')}
            testId="quality-count"
            minWidth={280}
          >
            {() => (
              <div className={styles.popStack}>
                <div className={styles.popRow}>
                  <span>{t('计数口径')}</span>
                  <SegmentedControl<'request' | 'attempt'>
                    aria-label={t('计数口径')}
                    data-testid="quality-count-by"
                    value={gateway ? p.count.countBy : 'request'}
                    disabled={!gateway}
                    onChange={(v) => p.onCount({ ...p.count, countBy: v })}
                    options={[
                      { value: 'request', label: t('按请求') },
                      { value: 'attempt', label: t('按尝试') },
                    ]}
                  />
                </div>
                <p className={styles.popHint}>
                  {gateway
                    ? t(
                        '按尝试：成功、失败、客户端错误、总数、成功率按上游尝试计（回退到别的候选时计多次），其余各列按请求。',
                      )
                    : t('CLI 层没有尝试的概念，一律按每一轮计。')}
                </p>
                <Switch
                  checked={p.count.cancelInDenominator}
                  onChange={(v) => p.onCount({ ...p.count, cancelInDenominator: v })}
                  label={t('取消计入成功率分母')}
                  data-testid="quality-cancel-denom"
                />
                <Switch
                  checked={p.count.includeRejected}
                  onChange={(v) => p.onCount({ ...p.count, includeRejected: v })}
                  label={t('客户端错误计入失败')}
                  data-testid="quality-include-rejected"
                />
              </div>
            )}
          </Popover>
          <button
            type="button"
            className={styles.iconChip}
            aria-label={t('刷新')}
            title={t('刷新')}
            onClick={p.onRefresh}
            data-testid="quality-refresh"
          >
            <Icon icon={RefreshCw} size={14} />
          </button>
          <button
            type="button"
            className={styles.iconChip}
            aria-label={t('导出 CSV')}
            title={p.onExport ? t('导出 CSV') : t('这个视图不能导出')}
            onClick={p.onExport}
            disabled={!p.onExport}
            data-testid="quality-export"
          >
            <Icon icon={Download} size={14} />
          </button>
          <Popover
            label={t('设置')}
            ariaLabel={t('模型质量设置')}
            icon={Settings2}
            iconOnly
            align="end"
            panelLabel={t('模型质量设置')}
            testId="quality-settings"
            minWidth={300}
          >
            {() => <QualitySettingsPanel onOpenPrivacy={p.onOpenPrivacy} />}
          </Popover>
        </span>
      </div>
      {active.length > 0 && (
        <ul
          className={styles.activeFilters}
          aria-label={t('当前筛选')}
          data-testid="quality-active-filters"
        >
          {active.map(([d, v]) => (
            <li key={d} className={styles.filterTag}>
              <span>
                {dimLabel(d)}：{v.map((x) => valueLabel(d, x, p.facets)).join('、')}
              </span>
              <button
                type="button"
                aria-label={t('移除筛选：{0}', dimLabel(d))}
                onClick={() => set(d, [])}
                data-testid={`quality-remove-${d}`}
              >
                <Icon icon={X} size={12} />
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className={styles.textBtn}
              onClick={() => p.onFilters({})}
              data-testid="quality-clear-filters"
            >
              {t('清除全部')}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
};
