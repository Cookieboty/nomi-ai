/**
 * 模型质量客户端：应用契约 `quality.*`（docs/design/model-quality.md，类型 @nomi-ai/types quality.ts）。
 * 只读元数据，不含对话内容。
 */
import type {
  QualityExportRequest,
  QualityExportResult,
  QualityFacets,
  QualityQuery,
  QualityRequestItem,
  QualityRequestsQuery,
  QualityResult,
  QualitySeries,
  QualitySeriesQuery,
  QualitySettings,
} from '@nomi-ai/types';
import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';

export type {
  QualityDimension,
  QualityDist,
  QualityFacet,
  QualityFacets,
  QualityExportResult,
  QualityLayer,
  QualityOutcome,
  QualityQuery,
  QualityRecord,
  QualityRequestItem,
  QualityRequestsQuery,
  QualityResult,
  QualitySeries,
  QualitySeriesQuery,
  QualitySettings,
  QualityStats,
} from '@nomi-ai/types';

export interface QualityRequestsPage {
  items: QualityRequestItem[];
  total: number;
}

async function call<T>(fn: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new Error(t('ui.model-quality.model-quality-requires-the-desktop-app'));
  return (await fn()) as T;
}

/** 数据变化通知合并成一次刷新（网关请求可能很密） */
export const QUALITY_REFRESH_DEBOUNCE_MS = 800;

export const qualityClient = {
  available: () => hasTransport(),
  query: (q: QualityQuery) => call<QualityResult>(() => api.quality.query(q)),
  series: (q: QualitySeriesQuery) => call<QualitySeries>(() => api.quality.series(q)),
  requests: (q: QualityRequestsQuery) => call<QualityRequestsPage>(() => api.quality.requests(q)),
  settings: () => call<QualitySettings>(() => api.quality.getSettings()),
  setSettings: (p: Partial<QualitySettings>) =>
    call<QualitySettings>(() => api.quality.setSettings(p)),
  clear: () => call<void>(() => api.quality.clear()),
  /** 筛选项：这段时间里出现过的客户端 / 供应商 / 模型族 / Key */
  facets: (q: Pick<QualityQuery, 'from' | 'to' | 'layer'>) =>
    call<QualityFacets>(() => api.quality.facets(q)),
  exportCsv: (
    kind: 'requests' | 'table',
    query: QualityQuery | QualityRequestsQuery,
  ): Promise<QualityExportResult> =>
    call<QualityExportResult>(() => api.quality.exportCsv({ kind, query } as QualityExportRequest)),
  /** 订阅数据变化（已防抖）；返回取消订阅 */
  onChanged: (fn: () => void): (() => void) => {
    if (!hasTransport()) return () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.on('quality.changed', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, QUALITY_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  },
};
