/**
 * 设置 → 模型质量（docs/design/model-quality.md §5）：总览 / 对比 / 趋势 / 请求明细。
 * 数据来自主进程 QualityService（ai:quality:*）；只有元数据，全部只存本机。
 * 两种测量口径分开看：网关层（HTTP 请求）与 CLI 层（Nomi 里运行的编程助手会话），不混算。
 */
import { EmptyState, Input, Select, Tabs, t } from '@nomi-ai/ui';
import { Activity } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

import { qualityClient, type QualityLayer } from '../../services/qualityClient';

import { Compare } from './Compare';
import { clientLabel, fromDateInput, rangeOf, toDateInput, type RangeId } from './format';
import styles from './index.module.css';
import { Overview } from './Overview';
import { RequestDetails } from './RequestDetails';
import { Trend } from './Trend';
import type { DrillFilters, QualityBase } from './types';

export type QualityTab = 'overview' | 'compare' | 'trend' | 'requests';

const CLIENTS = ['nomi', 'claude', 'codex', 'grok', 'gemini', 'dsh'];

export const QualityPanel: React.FC<{
  tab: QualityTab;
  onTab: (tab: QualityTab) => void;
  /** 跳到「设置 → 隐私与权限」（诊断日志 / 正文追踪） */
  onOpenPrivacy?: () => void;
  /** 测试注入：当前时间 */
  now?: () => number;
}> = ({ tab, onTab, onOpenPrivacy, now = Date.now }) => {
  const [rangeId, setRangeId] = useState<RangeId>('7d');
  const [custom, setCustom] = useState<{ from: number; to: number }>(() => {
    const r = rangeOf('7d', now());
    return r;
  });
  const [layer, setLayer] = useState<QualityLayer>('gateway');
  const [client, setClient] = useState('');
  // 从总览 / 对比钻取到请求明细时带过去的筛选（换了范围 / 口径不清，用户可逐个移除）
  const [drill, setDrill] = useState<DrillFilters>({});
  // 范围固定在打开 / 切换时的时刻，避免每次渲染都算出新的 to 导致反复查询
  const [stamp, setStamp] = useState(() => now());

  const range = useMemo(
    () => rangeOf(rangeId, stamp, rangeId === 'custom' ? custom : undefined),
    [rangeId, stamp, custom],
  );
  const base: QualityBase = useMemo(
    () => ({
      from: range.from,
      to: range.to,
      layer,
      ...(client ? { filters: { client: [client] } } : {}),
    }),
    [range.from, range.to, layer, client],
  );

  const refreshStamp = useCallback(() => setStamp(now()), [now]);

  const drillTo = useCallback(
    (f: DrillFilters) => {
      setDrill(f);
      onTab('requests');
    },
    [onTab],
  );

  if (!qualityClient.available())
    return (
      <section className={styles.root} data-testid="settings-quality">
        <EmptyState
          icon={Activity}
          title={t('模型质量仅在桌面应用中提供')}
          description={t('质量数据由本机主进程记录，网页预览中不可用。')}
        />
      </section>
    );

  return (
    <section className={styles.root} data-testid="settings-quality">
      <div className={styles.toolbar} role="group" aria-label={t('统计范围')}>
        <Tabs<RangeId>
          aria-label={t('统计时间范围')}
          value={rangeId}
          onChange={(v) => {
            setRangeId(v);
            setStamp(now());
          }}
          items={[
            { value: 'today', label: t('今天') },
            { value: '7d', label: t('7 天') },
            { value: '30d', label: t('30 天') },
            { value: 'custom', label: t('自定义') },
          ]}
        />
        {rangeId === 'custom' && (
          <span className={styles.dates}>
            <Input
              type="date"
              aria-label={t('开始日期')}
              data-testid="quality-from"
              value={toDateInput(custom.from)}
              onChange={(e) => {
                const v = fromDateInput(e.target.value);
                if (v != null && v <= custom.to) setCustom((c) => ({ ...c, from: v }));
              }}
            />
            <span aria-hidden>—</span>
            <Input
              type="date"
              aria-label={t('结束日期')}
              data-testid="quality-to"
              value={toDateInput(custom.to)}
              onChange={(e) => {
                const v = fromDateInput(e.target.value, true);
                if (v != null && v >= custom.from) setCustom((c) => ({ ...c, to: v }));
              }}
            />
          </span>
        )}
        <Tabs<QualityLayer>
          aria-label={t('测量口径')}
          value={layer}
          onChange={setLayer}
          items={[
            { value: 'gateway', label: t('网关层') },
            { value: 'cli', label: t('CLI 层') },
          ]}
        />
        <Select
          size="sm"
          className={styles.toolbarSelect}
          aria-label={t('按客户端筛选')}
          data-testid="quality-client"
          value={client}
          onChange={(e) => setClient(e.target.value)}
          options={[
            { value: '', label: t('全部客户端') },
            ...CLIENTS.map((c) => ({ value: c, label: clientLabel(c) })),
          ]}
        />
      </div>
      <p className={styles.layerNote} data-testid="quality-layer-note">
        {layer === 'gateway'
          ? t(
              '网关层：经 Nomi 统一网关的每个 HTTP 请求（Nomi 对话、编程助手的第三方供应商），有首字节、Key、回退等细节，最精确。',
            )
          : t(
              'CLI 层：Nomi 里运行的编程助手会话（官方账号与第三方都有），按 CLI 输出的一轮 / 一次模型调用计，时间含 CLI 自身开销，没有 Key。',
            )}{' '}
        {t('在终端里直接使用的 CLI 不经过 Nomi，不在统计范围内。')}
      </p>

      <Tabs<QualityTab>
        aria-label={t('模型质量分区')}
        value={tab}
        onChange={onTab}
        items={[
          { value: 'overview', label: t('总览') },
          { value: 'compare', label: t('对比') },
          { value: 'trend', label: t('趋势') },
          { value: 'requests', label: t('请求明细') },
        ]}
      />

      {tab === 'overview' && (
        <Overview
          base={base}
          onDrill={drillTo}
          onSwitchLayer={() => setLayer('cli')}
          onRefresh={refreshStamp}
        />
      )}
      {tab === 'compare' && (
        <Compare
          base={base}
          onDrill={drillTo}
          onSwitchLayer={() => setLayer('cli')}
          onRange={(id) => {
            setRangeId(id);
            setStamp(now());
          }}
        />
      )}
      {tab === 'trend' && <Trend base={base} rangeDays={(range.to - range.from) / 86_400_000} />}
      {tab === 'requests' && (
        <RequestDetails
          base={base}
          drill={drill}
          onDrill={setDrill}
          onOpenPrivacy={onOpenPrivacy}
        />
      )}
    </section>
  );
};

export default QualityPanel;
