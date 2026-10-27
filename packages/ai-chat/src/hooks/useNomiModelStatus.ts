import { gatewayClientAvailable, type GatewayState } from '../services/gatewayClient';
import { nomiMainRef, useGatewayState } from '../services/nomiModel';
import { providerOverrideActive } from '../services/providerClient';

/**
 * Nomi 对话的模型状态（与主进程 GatewayService.nomiPick 同一口径，见 services/nomiModel 的 nomiMainRef）：
 * - ready：已给 Nomi 对话选了模型（或有环境变量供应商 / NOMI_PROVIDER 锁定）；
 * - unassigned：网关里有可用的模型，但还没选给 Nomi 对话用；
 * - none：一个可用的模型都没有。
 * 没有桌面桥（浏览器 / 单测）时为 undefined；网关状态还没拉到时为 null。
 */
export type NomiModelStatus = 'ready' | 'unassigned' | 'none';

export function nomiModelStatus(s: GatewayState): NomiModelStatus {
  if (providerOverrideActive() || nomiMainRef(s)) return 'ready';
  const any = s.providers.some((p) => p.enabled && p.models.some((m) => m.enabled));
  return any ? 'unassigned' : 'none';
}

export function useNomiModelStatus(): NomiModelStatus | null | undefined {
  const s = useGatewayState();
  if (!gatewayClientAvailable()) return undefined;
  return s ? nomiModelStatus(s) : null;
}
