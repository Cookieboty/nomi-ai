/**
 * 测试用的统一网关：第三方会话的注入用真实的 agentLaunch（各 CLI 的环境变量 / 参数 / 叠加配置），
 * 地址与令牌是假的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { HarnessGateway } from '../../src/cli/CliHarnessService';
import { agentLaunch } from '../../src/gateway/agents';

export const TEST_GATEWAY_URL = 'http://127.0.0.1:18799';
export const TEST_GATEWAY_TOKEN = 'nomi-gw-test-token';

export function testGateway(
  o: {
    source?: 'official' | 'thirdParty';
    main?: string | null;
    running?: boolean;
    home?: string;
    models?: string[];
    /**
     * 模拟按标签令牌启动（§6.7）：launchForTab 签 `nomi-tab-<标签>-g<代次>`，记录登记 / 更新 / 作废；
     * Grok 按占位模型名启动（GatewayService.cliLaunchForTab 应给的 placeholder）。bindError：登记时抛出。
     */
    tabTokens?: boolean;
    bindError?: string;
  } = {},
): HarnessGateway & {
  launches: Array<[string, string, string]>;
  /** 'register <cli> <tab> <model> g<n>' / 'update <cli> <tab> <model>' / 'release <cli> <tab>' */
  bindings: string[];
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-gw-agents-'));
  const launches: Array<[string, string, string]> = [];
  const bindings: string[] = [];
  const generations = new Map<string, number>();
  const tabApi: Partial<HarnessGateway> = o.tabTokens
    ? {
        launchForTab: async (kind, tabId, model) => {
          if (o.running === false) return null;
          if (o.bindError) throw new Error(o.bindError);
          const key = `${kind}:${tabId}`;
          const g = (generations.get(key) ?? 0) + 1;
          generations.set(key, g);
          bindings.push(`register ${kind} ${tabId} ${model} g${g}`);
          const token = `nomi-tab-${tabId}-g${g}`;
          const l = agentLaunch(kind, {
            url: TEST_GATEWAY_URL,
            token,
            model,
            models: {},
            dir: path.join(dir, kind, tabId),
            home: o.home,
            ...(kind === 'grok' ? { placeholder: 'nomi' } : {}),
          });
          return { env: l.env, generation: g, modelInConfig: Boolean(l.modelInConfig) };
        },
        releaseTab: (kind, tabId) => {
          bindings.push(`release ${kind} ${tabId}`);
        },
        updateTab: async (kind, tabId, model) => {
          bindings.push(`update ${kind} ${tabId} ${model}`);
          return true;
        },
      }
    : {};
  return {
    launches,
    bindings,
    ...tabApi,
    defaults: () => ({
      source: o.source ?? 'official',
      model: o.main === undefined ? 'gw/main' : o.main,
    }),
    launch: (kind, tabId, model) => {
      launches.push([kind, tabId, model]);
      if (o.running === false) return null;
      return agentLaunch(kind, {
        url: TEST_GATEWAY_URL,
        token: TEST_GATEWAY_TOKEN,
        model,
        models: {},
        dir: path.join(dir, kind, tabId),
        home: o.home,
      });
    },
    officialEnv: (env) => {
      const out = { ...env };
      for (const [k, v] of Object.entries(out))
        if (v === TEST_GATEWAY_URL || v?.includes(TEST_GATEWAY_TOKEN)) delete out[k];
      return out;
    },
    models: () =>
      (o.models ?? ['gw/main', 'gw/other']).map((ref) => ({
        ref,
        provider: 'GW',
        label: ref.slice(3),
      })),
    releaseAgent: (kind, tabId) => {
      fs.rmSync(path.join(dir, kind, tabId), { recursive: true, force: true });
    },
  };
}
