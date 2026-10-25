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
  { dim: 'client', label: 'ui.model-quality.client' },
  { dim: 'provider', label: 'ui.providers-schedule.provider' },
  { dim: 'modelFamily', label: 'ui.foundation.model' },
  { dim: 'key', label: 'Key', gatewayOnly: true },
];

const dimLabel = (d: FilterDim): string =>
  d === 'outcome' ? t('ui.foundation.result') : t(FILTER_DIMS.find((x) => x.dim === d)?.label ?? d);

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
      <div
        className={styles.toolbar}
        role="toolbar"
        aria-label={t('ui.model-quality.range-and-filters')}
      >
        <SegmentedControl<RangeId>
          aria-label={t('ui.usage-tools.statistics-time-range')}
          data-testid="quality-range"
          value={p.rangeId}
          onChange={(v) => {
            p.onRange(v);
            if (v === 'custom') setCustomOpen(true);
          }}
          options={[
            { value: 'today', label: t('ui.chat-settings.today') },
            { value: '7d', label: t('ui.usage-tools.7-days') },
            { value: '30d', label: t('ui.usage-tools.30-days') },
            {
              value: 'custom',
              label: t('ui.providers-schedule.custom'),
              testId: 'quality-range-custom',
            },
          ]}
        />
        {p.rangeId === 'custom' && (
          <Popover
            label={`${formatDay(p.custom.from)} – ${formatDay(p.custom.to)}`}
            ariaLabel={t('ui.model-quality.custom-date-range')}
            icon={CalendarRange}
            panelLabel={t('ui.model-quality.custom-date-range')}
            open={customOpen}
            onOpenChange={setCustomOpen}
            testId="quality-custom"
          >
            {() => (
              <div className={styles.dateRow}>
                <label className={styles.popField}>
                  <span>{t('ui.model-quality.start')}</span>
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
                  <span>{t('ui.model-quality.end-76b988')}</span>
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
            aria-label={t('ui.model-quality.measurement-layer')}
            data-testid="quality-layer"
            value={p.layer}
            onChange={p.onLayer}
            options={[
              {
                value: 'gateway',
                label: t('ui.model-quality.gateway-layer'),
                testId: 'quality-layer-gateway',
              },
              { value: 'cli', label: t('ui.model-quality.cli-layer'), testId: 'quality-layer-cli' },
            ]}
          />
          <Tooltip
            placement="bottom-start"
            content={
              <span className={styles.tipBody}>
                <b>{t('ui.model-quality.gateway-layer')}</b>
                {t('ui.model-quality.every-http-request-through-the-nomi-gateway-nomi')}
                <b>{t('ui.model-quality.cli-layer')}</b>
                {t('ui.model-quality.coding-agents-running-in-nomi-official-accounts-and')}
                <span>{t('ui.model-quality.clis-used-directly-in-a-terminal-don-t')}</span>
              </span>
            }
          >
            <button
              type="button"
              className={styles.infoBtn}
              aria-label={t('ui.model-quality.about-the-two-measurement-layers')}
            >
              <Icon icon={Info} size={14} />
            </button>
          </Tooltip>
        </span>
        {p.showHierarchy && (
          <Popover
            label={hierarchyLabel(p.hierarchy, p.layer)}
            ariaLabel={t('ui.model-quality.levels', hierarchyLabel(p.hierarchy, p.layer))}
            icon={Layers}
            panelLabel={t('ui.model-quality.table-levels')}
            testId="quality-hierarchy"
            minWidth={220}
          >
            {(close) => (
              <RadioMenu<HierarchyId>
                label={t('ui.model-quality.table-levels')}
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
                      ? t('ui.model-quality.how-the-same-model-differs-across-providers-and')
                      : h.id === 'model-client-provider'
                        ? t('ui.model-quality.how-the-same-model-differs-across-coding-agents')
                        : h.id === 'client-model-provider'
                          ? t('ui.model-quality.which-models-each-coding-agent-used')
                          : t('ui.model-quality.which-models-each-provider-served'),
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
            panelLabel={t('ui.model-quality.filter-by', t(d.label))}
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
            label={t('ui.model-quality.counting')}
            icon={Ruler}
            align="end"
            panelLabel={t('ui.model-quality.counting-options')}
            testId="quality-count"
            minWidth={280}
          >
            {() => (
              <div className={styles.popStack}>
                <div className={styles.popRow}>
                  <span>{t('ui.model-quality.count-by')}</span>
                  <SegmentedControl<'request' | 'attempt'>
                    aria-label={t('ui.model-quality.count-by')}
                    data-testid="quality-count-by"
                    value={gateway ? p.count.countBy : 'request'}
                    disabled={!gateway}
                    onChange={(v) => p.onCount({ ...p.count, countBy: v })}
                    options={[
                      { value: 'request', label: t('ui.model-quality.requests') },
                      { value: 'attempt', label: t('ui.model-quality.attempts') },
                    ]}
                  />
                </div>
                <p className={styles.popHint}>
                  {gateway
                    ? t('ui.model-quality.by-attempt-success-failed-client-errors-total-and')
                    : t('ui.model-quality.the-cli-layer-has-no-attempts-everything-counts')}
                </p>
                <Switch
                  checked={p.count.cancelInDenominator}
                  onChange={(v) => p.onCount({ ...p.count, cancelInDenominator: v })}
                  label={t(
                    'ui.model-quality.include-cancellations-in-the-success-rate-denominator',
                  )}
                  data-testid="quality-cancel-denom"
                />
                <Switch
                  checked={p.count.includeRejected}
                  onChange={(v) => p.onCount({ ...p.count, includeRejected: v })}
                  label={t('ui.model-quality.count-client-errors-as-failures')}
                  data-testid="quality-include-rejected"
                />
              </div>
            )}
          </Popover>
          <button
            type="button"
            className={styles.iconChip}
            aria-label={t('ui.knowledge-local.refresh')}
            title={t('ui.knowledge-local.refresh')}
            onClick={p.onRefresh}
            data-testid="quality-refresh"
          >
            <Icon icon={RefreshCw} size={14} />
          </button>
          <button
            type="button"
            className={styles.iconChip}
            aria-label={t('ui.usage-tools.export-csv')}
            title={
              p.onExport
                ? t('ui.usage-tools.export-csv')
                : t('ui.model-quality.this-view-can-t-be-exported')
            }
            onClick={p.onExport}
            disabled={!p.onExport}
            data-testid="quality-export"
          >
            <Icon icon={Download} size={14} />
          </button>
          <Popover
            label={t('ui.foundation.settings')}
            ariaLabel={t('ui.model-quality.model-quality-settings')}
            icon={Settings2}
            iconOnly
            align="end"
            panelLabel={t('ui.model-quality.model-quality-settings')}
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
          aria-label={t('ui.model-quality.active-filters')}
          data-testid="quality-active-filters"
        >
          {active.map(([d, v]) => (
            <li key={d} className={styles.filterTag}>
              <span>
                {dimLabel(d)}：{v.map((x) => valueLabel(d, x, p.facets)).join('、')}
              </span>
              <button
                type="button"
                aria-label={t('ui.model-quality.remove-filter', dimLabel(d))}
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
              {t('ui.knowledge-local.clear-all')}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
};
