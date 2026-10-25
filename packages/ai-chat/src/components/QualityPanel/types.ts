/** 模型质量面板内部共用的类型 */
import type { QualityDimension, QualityLayer } from '../../services/qualityClient';

/** 工具栏的筛选芯片：客户端 / 供应商 / 模型族 / Key；钻取还会带上结果 */
export type FilterDim = 'client' | 'provider' | 'modelFamily' | 'key' | 'outcome';

export type Filters = Partial<Record<FilterDim, string[]>>;

/** 各标签页共用的查询范围（时间、口径、筛选） */
export interface QualityBase {
  from: number;
  to: number;
  layer: QualityLayer;
  filters?: Partial<Record<QualityDimension, string[]>>;
}

/** 口径设置（「口径」弹层） */
export interface CountOptions {
  countBy: 'request' | 'attempt';
  cancelInDenominator: boolean;
  includeRejected: boolean;
}

/** 去掉空的筛选维度；全空返回 undefined */
export const cleanFilters = (f: Filters): Filters | undefined => {
  const out: Filters = {};
  for (const [k, v] of Object.entries(f) as Array<[FilterDim, string[] | undefined]>)
    if (v?.length) out[k] = v;
  return Object.keys(out).length ? out : undefined;
};
