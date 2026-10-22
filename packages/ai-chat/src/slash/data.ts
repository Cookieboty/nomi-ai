/** 命令执行时按需读取的本机数据（只读主进程缓存 / 账本，不联网、不碰凭据） */
import { cliAccountClient } from '../services/cliAccountClient';
import { cliUpdateClient } from '../services/cliUpdateClient';
import { gatewayClient, gatewayClientAvailable } from '../services/gatewayClient';
import { harnessClient } from '../services/harnessClient';
import { providerClient } from '../services/providerClient';
import { usageClient, type UsageEndpointInfo } from '../services/usageClient';
import type { ConversationBackend } from '../types/chat';

import type { SlashData } from './types';

const soft = async <T>(p: () => Promise<T>): Promise<T | null> => {
  try {
    return await p();
  } catch {
    return null;
  }
};

const isEndpoint = (u: unknown): u is UsageEndpointInfo => {
  const x = u as Partial<UsageEndpointInfo> | null;
  return !!x && typeof x === 'object' && !!x.today && !!x.week && Array.isArray(x.byModel);
};

export async function loadSlashData(
  backend: ConversationBackend,
  tabId?: string | null,
): Promise<SlashData> {
  const cli = backend !== 'nomi';
  const accountKind = cli && backend !== 'dsh' ? backend : null;
  const [clis, usage, quotas, accounts, tabs, nomiProviders, gateway] = await Promise.all([
    cli && cliUpdateClient.available()
      ? soft(() => cliUpdateClient.inspect(false))
      : Promise.resolve(null),
    usageClient.available() ? soft(() => usageClient.endpoint(backend)) : Promise.resolve(null),
    cli && usageClient.available() ? soft(() => usageClient.quota()) : Promise.resolve(null),
    accountKind ? soft(() => cliAccountClient.list(accountKind)) : Promise.resolve(null),
    cli && tabId && harnessClient.available()
      ? soft(() => harnessClient.tabs())
      : Promise.resolve(null),
    !cli ? soft(() => providerClient.state()) : Promise.resolve(null),
    gatewayClientAvailable() ? soft(() => gatewayClient.state()) : Promise.resolve(null),
  ]);
  return {
    cli: Array.isArray(clis) ? (clis.find((c) => c.kind === backend) ?? null) : null,
    usage: isEndpoint(usage) ? usage : null,
    quota: Array.isArray(quotas) ? (quotas.find((q) => q.id === backend) ?? null) : null,
    cliAccount: Array.isArray(accounts)
      ? (accounts.find((a) => a.kind === accountKind && a.active) ?? null)
      : null,
    cliTab:
      tabs && Array.isArray(tabs.tabs) ? (tabs.tabs.find((x) => x.id === tabId) ?? null) : null,
    nomiProviders: nomiProviders && Array.isArray(nomiProviders.providers) ? nomiProviders : null,
    nomiGateway: gateway && Array.isArray(gateway.providers) ? gateway : null,
  };
}
