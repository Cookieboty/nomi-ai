/**
 * 请求方向的模型规则（§6.9.5～§6.9.6，ModelAdapter.request）：作用在「上游协议的请求体」上，
 * 同协议透传与跨协议转换两条路径都执行。每条规则只在模型规格里有对应数据时生效，
 * 同协议且没有任何规则命中时请求体与迁移前逐字节一致。
 */
import type { Wire } from '../../../ir';
import type { EffectiveModel } from '../../types';

import { dropReasoning, fitThinkingBudget, stripImages } from './content';
import { normalizeParams, type ParamChanges } from './params';
import { cleanSchemas } from './schema';

export { fitLevel, renderReasoning, type RenderedReasoning } from './reasoning';
export { normalizeParams, UnsupportedParamError, type ParamChanges } from './params';
export { cleanSchemas, geminiExpressible, inlineRefs } from './schema';
export { IMAGE_OMITTED_TEXT } from './content';

type Obj = Record<string, unknown>;

/** 就地改写 o（调用方给的浅拷贝）；返回参数的改动（RoutePlan.params） */
export function modelRequest(wire: Wire, o: Obj, m: EffectiveModel, notes: string[]): ParamChanges {
  const changes = normalizeParams(wire, o, m, notes);
  // 用户把模型设为不支持推理：去掉推理参数（只认用户设置，目录说的不算——目录错了会静默丢掉思考）
  if (m.userSet.includes('reasoning') && m.reasoning?.control === 'none')
    dropReasoning(o, wire, notes);
  if (wire === 'messages') fitThinkingBudget(o, notes);
  if (m.input?.images === false) stripImages(o, wire, notes);
  cleanSchemas(wire, o, m, notes);
  return changes;
}
