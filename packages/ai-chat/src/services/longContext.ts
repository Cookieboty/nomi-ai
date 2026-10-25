/**
 * 第三方模型的长上下文（docs/design/unified-gateway.md §12.7.2）：按长度分档计价的模型默认按标准窗口
 * （超过它加价）压缩，用户可按标签开启长上下文，或在「模型」页按模型设默认。
 * 输入栏模型菜单与上下文环共用这里的判断。
 */
import { formatContext, t } from '@nomi-ai/ui';

import { tabSourceOf, thirdPartyRefOf } from './cliSource';
import type { GatewayState } from './gatewayClient';
import type { HarnessTabMeta } from './harnessClient';
import { splitRef } from './nomiModel';

export interface LongContextInfo {
  /** 标签当前的第三方模型（供应商/模型） */
  ref: string;
  /** 标准窗口 / 最大输入（token） */
  standard: number;
  full: number;
  /** 这个标签现在是否开着长上下文（标签的选择优先，否则跟随模型默认） */
  on: boolean;
  /** 模型的默认（「模型」页设置） */
  modelDefault: boolean;
  /** 超过标准窗口后的单价说明；价格表里没有分档时为 undefined */
  priceNote?: string;
}

/** 美元单价按价格表原样显示（表里本就是精确值，如 4、0.2） */
const usd = (n: number) => `$${n}`;

/** 标签当前模型的长上下文信息；不是第三方标签、或模型没有长上下文可开时为 null */
export function longContextFor(
  tab: HarnessTabMeta,
  gateway: GatewayState | null,
): LongContextInfo | null {
  if (tabSourceOf(tab) !== 'thirdParty' || !gateway) return null;
  const ref = thirdPartyRefOf(tab, tab.backend, gateway);
  const r = ref ? splitRef(ref) : null;
  if (!ref || !r) return null;
  const m = gateway.providers
    .find((p) => p.id === r.provider)
    ?.models.find((x) => x.id === r.model);
  const lc = m?.effective?.longContext;
  if (!lc) return null;
  const choice = tab.longContext?.model === ref ? tab.longContext.on : undefined;
  const p = lc.price;
  return {
    ref,
    standard: lc.standard,
    full: lc.full,
    on: choice ?? lc.on,
    modelDefault: lc.on,
    ...(p
      ? {
          priceNote: t(
            'ui.models.long-context-price',
            formatContext(p.size),
            usd(p.tierInput),
            usd(p.input),
          ),
        }
      : {}),
  };
}

/**
 * 这个标签的第三方模型下次启动时注入的上下文窗口（标准 / 长上下文按标签的选择，其余按生效值）。
 * 不是第三方标签、或网关里没有这个模型时为 null。
 */
export function injectedWindowFor(
  tab: HarnessTabMeta,
  gateway: GatewayState | null,
): number | null {
  if (tabSourceOf(tab) !== 'thirdParty' || !gateway) return null;
  const long = longContextFor(tab, gateway);
  if (long) return long.on ? long.full : long.standard;
  const ref = thirdPartyRefOf(tab, tab.backend, gateway);
  const r = ref ? splitRef(ref) : null;
  const m = r
    ? gateway.providers.find((p) => p.id === r.provider)?.models.find((x) => x.id === r.model)
    : undefined;
  return m?.effective?.ctx ?? null;
}

/**
 * CLI 上报的窗口是否就是这次注入的：Claude 原样上报，Codex 上报 95%（effective_context_window_percent），
 * 落在注入值的 90%~100% 之间算同一个。不匹配说明上报来自换模型 / 切长上下文之前，已过期。
 */
export const reportedMatchesInjected = (reported: number, injected: number): boolean =>
  reported <= injected && reported >= injected * 0.9;

/** 上下文环提示开启长上下文的阈值：标准窗口的 70%（CLI 自动压缩一般在 80%~90%，要赶在它之前） */
export const LONG_CONTEXT_HINT_RATIO = 0.7;
