/** 模型质量面板内部共用的类型 */
import type { QualityDimension, QualityLayer } from '../../services/qualityClient';

/** 各标签页共用的查询范围（时间、口径、客户端筛选） */
export interface QualityBase {
  from: number;
  to: number;
  layer: QualityLayer;
  filters?: Partial<Record<QualityDimension, string[]>>;
}

/** 钻取到请求明细时带的筛选 */
export type DrillFilters = Partial<Record<QualityDimension, string[]>>;

/** 维度筛选：分组键 → 钻取筛选 */
export const drillOf = (dim: QualityDimension | undefined, key: string): DrillFilters =>
  dim ? { [dim]: [key] } : {};

/** 合并筛选（同一维度取后者） */
export const mergeFilters = (
  a: DrillFilters | undefined,
  b: DrillFilters | undefined,
): DrillFilters | undefined => {
  const out = { ...(a ?? {}), ...(b ?? {}) };
  return Object.keys(out).length ? out : undefined;
};
