/**
 * 设置 → 模型质量（docs/design/model-quality.md §5）：对比（多级对比表）/ 趋势 / 请求明细。
 * 一行工具栏（时间、口径层、层级、筛选芯片；右侧口径、刷新、导出、设置）；设置放进 ⚙ 弹层，不占内容区。
 * 数据来自主进程 QualityService（ai:quality:*）；只有元数据，全部只存本机。
 */
import { EmptyState, Tabs, t } from '@nomi-ai/ui';
import { Activity } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

import { qualityClient, type QualityFacets, type QualityLayer } from '../../services/qualityClient';

import { CompareTable } from './CompareTable';
import { hierarchyPath, rangeOf, type HierarchyId, type RangeId } from './format';
import styles from './index.module.css';
import { RequestDetails } from './RequestDetails';
import { useQualityData } from './shared';
import { Toolbar } from './Toolbar';
import { Trend } from './Trend';
import { cleanFilters, type CountOptions, type Filters, type QualityBase } from './types';

export type QualityTab = 'compare' | 'trend' | 'requests';

export const QualityPanel: React.FC<{
  /** 旧的深链接「总览」落到「对比」（指标卡在对比表上方） */
  tab: QualityTab | 'overview';
  onTab: (tab: QualityTab) => void;
  /** 跳到「设置 → 隐私与权限」（诊断日志 / 正文追踪） */
  onOpenPrivacy?: () => void;
  /** 外层已有同名标签（设置 → 用量与质量）：不再渲染自己的标签条 */
  hideTabs?: boolean;
  /** 测试注入：当前时间 */
  now?: () => number;
}> = ({ tab: tabProp, onTab, onOpenPrivacy, hideTabs, now = Date.now }) => {
  const tab = tabProp === 'overview' ? 'compare' : tabProp;
  const [rangeId, setRangeId] = useState<RangeId>('7d');
  const [custom, setCustom] = useState<{ from: number; to: number }>(() => rangeOf('7d', now()));
  const [layer, setLayer] = useState<QualityLayer>('gateway');
  const [hierarchy, setHierarchy] = useState<HierarchyId>('model-provider-key');
  const [filters, setFilters] = useState<Filters>({});
  const [count, setCount] = useState<CountOptions>({
    countBy: 'attempt',
    cancelInDenominator: false,
    includeRejected: false,
  });
  const [msg, setMsg] = useState<string | null>(null);
  // 范围固定在打开 / 切换 / 刷新时的时刻，避免每次渲染都算出新的 to 导致反复查询
  const [stamp, setStamp] = useState(() => now());

  const range = useMemo(
    () => rangeOf(rangeId, stamp, rangeId === 'custom' ? custom : undefined),
    [rangeId, stamp, custom],
  );
  // CLI 层没有 Key：筛选里的 Key 不生效
  const effective = useMemo(
    () => cleanFilters(layer === 'gateway' ? filters : { ...filters, key: [] }),
    [filters, layer],
  );
  // 对比 / 趋势不按结果筛（结果是列）；请求明细按结果筛
  const scoped = useMemo(() => {
    if (!effective || tab === 'requests') return effective;
    const { outcome: _o, ...rest } = effective;
    void _o;
    return cleanFilters(rest);
  }, [effective, tab]);
  const base: QualityBase = useMemo(
    () => ({ from: range.from, to: range.to, layer, ...(scoped ? { filters: scoped } : {}) }),
    [range.from, range.to, layer, scoped],
  );
  const filtered = !!scoped;
  const path = hierarchyPath(hierarchy, layer);

  const facets = useQualityData<QualityFacets>(JSON.stringify([range.from, range.to, layer]), () =>
    qualityClient.facets({ from: range.from, to: range.to, layer }),
  );

  const refresh = useCallback(() => setStamp(now()), [now]);
  const drill = useCallback(
    (f: Filters) => {
      setFilters((prev) => ({ ...prev, ...f }));
      onTab('requests');
    },
    [onTab],
  );

  const exportCsv = () => {
    setMsg(null);
    const run =
      tab === 'compare'
        ? qualityClient.exportCsv('table', {
            ...base,
            groupPath: path,
            countBy: layer === 'gateway' ? count.countBy : 'request',
            ...(count.cancelInDenominator ? { cancelInDenominator: true } : {}),
            ...(count.includeRejected ? { includeRejected: true } : {}),
          })
        : qualityClient.exportCsv('requests', {
            from: base.from,
            to: base.to,
            layer,
            ...(base.filters ? { filters: base.filters } : {}),
            limit: 1000,
          });
    void run
      .then((r) => setMsg(r.ok && r.path ? t('ui.knowledge-local.exported-to-path', r.path) : null))
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)));
  };

  if (!qualityClient.available())
    return (
      <section className={styles.root} data-testid="settings-quality">
        <EmptyState
          icon={Activity}
          title={t('ui.model-quality.model-quality-is-only-available-in-the-desktop')}
          description={t('ui.model-quality.quality-data-is-recorded-by-the-local-main')}
        />
      </section>
    );

  return (
    <section className={styles.root} data-testid="settings-quality">
      <Toolbar
        rangeId={rangeId}
        onRange={(v) => {
          setRangeId(v);
          setStamp(now());
        }}
        custom={custom}
        onCustom={setCustom}
        layer={layer}
        onLayer={setLayer}
        hierarchy={hierarchy}
        onHierarchy={setHierarchy}
        showHierarchy={tab === 'compare'}
        filters={tab === 'requests' ? filters : { ...filters, outcome: [] }}
        onFilters={(f) =>
          // 「清除全部」连同只在请求明细里显示的结果筛选一起清
          setFilters(
            tab === 'requests' || !Object.keys(f).length ? f : { ...f, outcome: filters.outcome },
          )
        }
        facets={facets.data}
        count={count}
        onCount={setCount}
        onRefresh={() => {
          refresh();
          facets.reload();
        }}
        onExport={tab === 'trend' ? undefined : exportCsv}
        onOpenPrivacy={onOpenPrivacy}
      />
      {msg && (
        <p className={styles.meta} role="status" data-testid="quality-export-msg">
          {msg}
        </p>
      )}
      {!hideTabs && (
        <Tabs<'compare' | 'trend' | 'requests'>
          variant="underline"
          aria-label={t('ui.model-quality.model-quality-sections')}
          value={tab}
          onChange={onTab}
          items={[
            { value: 'compare', label: t('ui.model-quality.compare') },
            { value: 'trend', label: t('ui.usage-tools.trend') },
            { value: 'requests', label: t('ui.model-quality.request-details') },
          ]}
        />
      )}
      {tab === 'compare' && (
        <CompareTable
          base={base}
          path={path}
          count={count}
          filtered={filtered}
          onClearFilters={() => setFilters({})}
          onDrill={drill}
          onSwitchLayer={() => setLayer('cli')}
        />
      )}
      {tab === 'trend' && (
        <Trend
          base={base}
          rangeDays={(range.to - range.from) / 86_400_000}
          count={count}
          filtered={filtered}
          onClearFilters={() => setFilters({})}
        />
      )}
      {tab === 'requests' && (
        <RequestDetails base={base} filters={filters} onFilters={setFilters} filtered={filtered} />
      )}
    </section>
  );
};

export default QualityPanel;
