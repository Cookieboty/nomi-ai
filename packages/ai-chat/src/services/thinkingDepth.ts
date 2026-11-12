import type { GatewayState } from './gatewayClient';
import { gatewayStateSnapshot, nomiMainRef, splitRef } from './nomiModel';

/** 一个模型在输入栏里可调的思考深度。default 是 levels 的第二档。 */
export interface ThinkingProfile {
  control: string;
  levels: string[];
  default: string;
}

/**
 * 不提供给用户选的档位：off / none 是「不思考」，产品上不要这一档。
 * 网关仍会按模型能力给出它，这里直接滤掉。
 */
const HIDDEN_LEVELS = new Set(['off', 'none']);

/** 网关状态里这个模型的思考深度；不支持或少于两档时没有选择器。 */
export function thinkingProfileOf(
  state: GatewayState | null,
  ref: string | null,
): ThinkingProfile | null {
  const parts = ref ? splitRef(ref) : null;
  if (!state || !parts) return null;
  const model = state.providers
    .find((p) => p.id === parts.provider)
    ?.models.find((m) => m.id === parts.model);
  const th = model?.effective?.thinking;
  if (!th || !Array.isArray(th.levels)) return null;
  const levels = th.levels
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .filter((x) => !HIDDEN_LEVELS.has(x.toLowerCase()));
  if (levels.length < 2) return null;
  const fallback = levels[1] ?? levels[0];
  const def = typeof th.default === 'string' && levels.includes(th.default) ? th.default : fallback;
  if (!def) return null;
  return { control: th.control, levels, default: def };
}

/**
 * 会话里存的档位还在这个模型的列表里就用它，否则用第二档。
 * 模型不支持思考深度时返回 undefined（请求不带参数）。
 */
export function resolveThinkingLevel(
  stored: string | undefined,
  profile: ThinkingProfile | null,
): string | undefined {
  if (!profile) return undefined;
  if (stored && profile.levels.includes(stored)) return stored;
  return profile.default;
}

/** 当前 Nomi 对话模型上，这一轮应该发出的档位。 */
export function currentNomiThinking(stored?: string): string | undefined {
  const state = gatewayStateSnapshot();
  return resolveThinkingLevel(stored, thinkingProfileOf(state, nomiMainRef(state)));
}
