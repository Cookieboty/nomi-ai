/**
 * 编排器与统一网关之间的接线（docs/design/unified-gateway.md §12、cli-plugin-architecture.md §6.7）。
 * 应用启动和真实 CLI 的集成测试都用这一份，测试不再自己拼一个可能和实际不一致的网关替身。
 */
import type { HarnessGateway } from '../cli/CliHarnessService';

import type { GatewayService } from './GatewayService';

export function harnessGateway(gateway: GatewayService): HarnessGateway {
  return {
    defaults: (kind) => gateway.cliDefaults(kind),
    launch: (kind, tabId, model, opts) => gateway.cliLaunch(kind, tabId, model, opts),
    officialEnv: (env) => gateway.officialEnv(env),
    models: () => gateway.cliModels(),
    releaseAgent: (kind, tabId) => gateway.releaseAgent(kind, tabId),
    // 第三方进程按标签令牌启动：先在网关登记绑定、等确认，再拉起（§6.7）
    launchForTab: async (kind, tabId, model, effort, longContext) => {
      const l = await gateway.cliLaunchForTab(kind, tabId, model, effort, longContext);
      return l
        ? { env: l.env, generation: l.generation, modelInConfig: Boolean(l.modelInConfig) }
        : null;
    },
    releaseTab: (kind, tabId, generation) => gateway.releaseTab(kind, tabId, generation),
    // gateway / inplace 型换模型：只改绑定的主模型，其余槽位（档位 / 辅助 / 子代理）沿用客户端配置
    updateTab: (kind, tabId, model, effort) =>
      gateway.tabs.update({
        client: kind,
        tabId,
        models: { ...gateway.store.snapshot().clients[kind]?.models, main: model },
        ...(effort ? { effort } : {}),
      }),
  };
}
