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
    /**
     * 登记到网关确认之间的延迟（ms）。和 GatewayService 的 TabTokens 一样，新代次在等确认前就已是
     * 「当前」代次：用来复现旧进程的退出事件晚于新代次登记的时序。
     */
    bindDelayMs?: number;
  } = {},
): HarnessGateway & {
  launches: Array<[string, string, string]>;
  /** 每次启动（同步注入与按标签登记）带的长上下文选择；undefined = 跟随模型默认 */
  longContexts: Array<boolean | undefined>;
  /**
   * 'register <cli> <tab> <model> g<n>' / 'update <cli> <tab> <model>' /
   * 'release <cli> <tab> g<n>'（进程退出，只作废那一代）/ 'release <cli> <tab>'（标签关闭）
   */
  bindings: string[];
  /** 这个标签当前有效的代次（已作废 = undefined）；和 TabTokens 的语义一致 */
  live(kind: string, tabId: string): number | undefined;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-gw-agents-'));
  const launches: Array<[string, string, string]> = [];
  const longContexts: Array<boolean | undefined> = [];
  /** 开了长上下文时主模型的窗口（与 GatewayService.agentMeta 一样只作用于标签的主模型） */
  const metaFor = (model: string, longContext: boolean | undefined) =>
    longContext ? { metaOf: (ref: string) => (ref === model ? { ctx: 900_000 } : undefined) } : {};
  const bindings: string[] = [];
  const generations = new Map<string, number>();
  const active = new Map<string, number>();
  const tabApi: Partial<HarnessGateway> = o.tabTokens
    ? {
        launchForTab: async (kind, tabId, model, _effort, longContext) => {
          longContexts.push(longContext);
          if (o.running === false) return null;
          if (o.bindError) throw new Error(o.bindError);
          const key = `${kind}:${tabId}`;
          const g = (generations.get(key) ?? 0) + 1;
          generations.set(key, g);
          active.set(key, g);
          bindings.push(`register ${kind} ${tabId} ${model} g${g}`);
          if (o.bindDelayMs) await new Promise((r) => setTimeout(r, o.bindDelayMs));
          const token = `nomi-tab-${tabId}-g${g}`;
          const l = agentLaunch(kind, {
            url: TEST_GATEWAY_URL,
            token,
            model,
            models: {},
            dir: path.join(dir, kind, tabId),
            home: o.home,
            ...(kind === 'grok' ? { placeholder: 'nomi' } : {}),
            ...metaFor(model, longContext),
          });
          return { env: l.env, generation: g, modelInConfig: Boolean(l.modelInConfig) };
        },
        releaseTab: (kind, tabId, generation) => {
          bindings.push(
            `release ${kind} ${tabId}${generation === undefined ? '' : ` g${generation}`}`,
          );
          const key = `${kind}:${tabId}`;
          const cur = active.get(key);
          if (cur === undefined || (generation !== undefined && cur !== generation)) return;
          active.delete(key);
        },
        updateTab: async (kind, tabId, model) => {
          bindings.push(`update ${kind} ${tabId} ${model}`);
          return true;
        },
      }
    : {};
  return {
    launches,
    longContexts,
    bindings,
    live: (kind, tabId) => active.get(`${kind}:${tabId}`),
    ...tabApi,
    defaults: () => ({
      source: o.source ?? 'official',
      model: o.main === undefined ? 'gw/main' : o.main,
      accountId: null,
    }),
    launch: (kind, tabId, model, opts) => {
      launches.push([kind, tabId, model]);
      longContexts.push(opts?.longContext);
      if (o.running === false) return null;
      return agentLaunch(kind, {
        url: TEST_GATEWAY_URL,
        token: TEST_GATEWAY_TOKEN,
        model,
        models: {},
        dir: path.join(dir, kind, tabId),
        home: o.home,
        // 与 GatewayService.cliLaunch 一致：按标签令牌启动的 Grok 写占位模型名
        ...(opts?.tabBound && kind === 'grok' ? { placeholder: 'nomi' } : {}),
        ...metaFor(model, opts?.longContext),
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
