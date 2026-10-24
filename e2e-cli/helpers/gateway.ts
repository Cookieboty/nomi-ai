/**
 * 进程内启动网关（直接用源码，不依赖 dist），上游指向假上游。
 */
import type { GatewayConfig, RuntimeModel } from '../../packages/gateway/src/config';
import type { Wire } from '../../packages/gateway/src/ir';
import { createGateway, type GatewayServer } from '../../packages/gateway/src/server';

import type { FakeUpstream } from './upstream';

export const TOKENS = {
  claude: 'nomi-gw-e2e-claude',
  codex: 'nomi-gw-e2e-codex',
  grok: 'nomi-gw-e2e-grok',
  gemini: 'nomi-gw-e2e-gemini',
} as const;

export interface TestGateway {
  url: string;
  gw: GatewayServer;
  notes: string[];
  stop(): Promise<void>;
}

/**
 * wires：假上游声明支持的协议（同一个地址按路径分发）；model：唯一的模型 `up/<model>`。
 */
export async function startGateway(
  up: FakeUpstream,
  o: { wires: Wire[]; model?: string; modelMeta?: Partial<RuntimeModel> },
): Promise<TestGateway> {
  const model = o.model ?? 'gpt-x';
  const urls: Partial<Record<Wire, string>> = {};
  for (const w of o.wires) urls[w] = w === 'messages' ? up.base : `${up.base}/v1`;
  const notes: string[] = [];
  const cfg = {
    host: '127.0.0.1',
    port: 0,
    providers: [
      {
        id: 'up',
        name: 'UP',
        enabled: true,
        urls,
        keys: [{ id: 'k1', name: 'k', value: 'upstream-key', enabled: true }],
        models: [{ id: model, enabled: true, ...o.modelMeta }],
      },
    ],
    clients: {
      claude: { token: TOKENS.claude, models: { main: `up/${model}` } },
      codex: { token: TOKENS.codex, models: { main: `up/${model}` } },
      grok: { token: TOKENS.grok, models: { main: `up/${model}` } },
      gemini: { token: TOKENS.gemini, models: { main: `up/${model}` } },
    },
    allowedPrivateHosts: [up.hostPort],
  } as unknown as GatewayConfig;
  const gw = createGateway(cfg, {
    logger: {
      info: (m: string, d?: unknown) => {
        if (m === 'gateway request fixes') notes.push(JSON.stringify(d));
      },
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
  });
  await gw.start();
  return { url: gw.listenUrl()!, gw, notes, stop: async () => gw.stop() };
}
