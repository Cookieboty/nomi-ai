/**
 * 模型质量客户端：`ai:quality:*` IPC（docs/design/model-quality.md，契约 @nomi-ai/types quality.ts）。
 * 经 preload 的 window.aiIPC；只读元数据，不含对话内容。
 */
import type {
  QUALITY_IPC as QualityIpc,
  QualityExportRequest,
  QualityExportResult,
  QualityFacets,
  QualityQuery,
  QualityRecord,
  QualityRequestsQuery,
  QualityResult,
  QualitySeries,
  QualitySeriesQuery,
  QualitySettings,
} from '@nomi-ai/types';
import { t } from '@nomi-ai/ui';

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
  QualityRequestsQuery,
  QualityResult,
  QualitySeries,
  QualitySeriesQuery,
  QualitySettings,
  QualityStats,
} from '@nomi-ai/types';

/**
 * 通道名：与 @nomi-ai/types 的 QUALITY_IPC 相同（类型上校验一致）。不在运行时从 types 包导入值：
 * 它编译成 CommonJS，开发态 Vite 不预构建工作区包。
 */
const QUALITY_IPC = {
  query: 'ai:quality:query',
  series: 'ai:quality:series',
  requests: 'ai:quality:requests',
  settingsGet: 'ai:quality:settings-get',
  settingsSet: 'ai:quality:settings-set',
  clear: 'ai:quality:clear',
  export: 'ai:quality:export',
  facets: 'ai:quality:facets',
  changed: 'ai:quality:changed',
} as const satisfies typeof QualityIpc;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _ipcInSync: Same<typeof QUALITY_IPC, typeof QualityIpc> = true;
void _ipcInSync;

/** CSV 导出（主进程弹保存对话框写文件） */
export const QUALITY_EXPORT_CHANNEL = QUALITY_IPC.export;

export interface QualityRequestsPage {
  items: QualityRecord[];
  total: number;
}

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, fn: (payload: unknown) => void) => () => void;
}

const bridge = (): AiBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('模型质量需要在桌面应用中使用'));
  const r = (await b.invoke(channel, ...args)) as T & { __error?: { message: string } };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

/** 数据变化通知合并成一次刷新（网关请求可能很密） */
export const QUALITY_REFRESH_DEBOUNCE_MS = 800;

export const qualityClient = {
  available: () => !!bridge(),
  query: (q: QualityQuery) => call<QualityResult>(QUALITY_IPC.query, q),
  series: (q: QualitySeriesQuery) => call<QualitySeries>(QUALITY_IPC.series, q),
  requests: (q: QualityRequestsQuery) => call<QualityRequestsPage>(QUALITY_IPC.requests, q),
  settings: () => call<QualitySettings>(QUALITY_IPC.settingsGet),
  setSettings: (p: Partial<QualitySettings>) => call<QualitySettings>(QUALITY_IPC.settingsSet, p),
  clear: () => call<void>(QUALITY_IPC.clear),
  /** 筛选项：这段时间里出现过的客户端 / 供应商 / 模型族 / Key */
  facets: (q: Pick<QualityQuery, 'from' | 'to' | 'layer'>) =>
    call<QualityFacets>(QUALITY_IPC.facets, q),
  exportCsv: (
    kind: 'requests' | 'table',
    query: QualityQuery | QualityRequestsQuery,
  ): Promise<QualityExportResult> =>
    call<QualityExportResult>(QUALITY_IPC.export, { kind, query } as QualityExportRequest),
  /** 订阅数据变化（已防抖）；返回取消订阅 */
  onChanged: (fn: () => void): (() => void) => {
    const b = bridge();
    if (!b) return () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = b.on(QUALITY_IPC.changed, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, QUALITY_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  },
};
