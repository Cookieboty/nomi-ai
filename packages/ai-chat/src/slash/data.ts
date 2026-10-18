/** 命令执行时按需读取的本机数据（只读主进程缓存 / 账本，不联网、不碰凭据） */
import { cliProviderClient } from '../services/cliProviderClient';
import { cliUpdateClient } from '../services/cliUpdateClient';
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

export async function loadSlashData(backend: ConversationBackend): Promise<SlashData> {
  const cli = backend !== 'nomi';
  const [clis, usage, quotas, cliProviders, nomiProviders] = await Promise.all([
    cli && cliUpdateClient.available()
      ? soft(() => cliUpdateClient.inspect(false))
      : Promise.resolve(null),
    usageClient.available() ? soft(() => usageClient.endpoint(backend)) : Promise.resolve(null),
    cli && usageClient.available() ? soft(() => usageClient.quota()) : Promise.resolve(null),
    cli ? soft(() => cliProviderClient.state()) : Promise.resolve(null),
    !cli ? soft(() => providerClient.state()) : Promise.resolve(null),
  ]);
  return {
    cli: Array.isArray(clis) ? (clis.find((c) => c.kind === backend) ?? null) : null,
    usage: isEndpoint(usage) ? usage : null,
    quota: Array.isArray(quotas) ? (quotas.find((q) => q.id === backend) ?? null) : null,
    cliProviders: cliProviders && Array.isArray(cliProviders.profiles) ? cliProviders : null,
    nomiProviders: nomiProviders && Array.isArray(nomiProviders.providers) ? nomiProviders : null,
  };
}
