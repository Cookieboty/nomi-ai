/**
 * 把编程助手插件的网关侧入口组装进网关内核（docs/design/cli-plugin-architecture.md §5.5、P9.5）。
 * 网关内核只带 Nomi 自己的客户端规格，各 CLI 的规格是插件里的数据；网关进程启动时在这里登记。
 * 插件包不依赖网关内核，形状一致由这里的类型核对（GatewayClientSpec → ClientSpec）。
 */
import type { CliGatewayEntry } from '@nomi-ai/cli-plugins/gateways';
import { registerClientSpec, type ClientSpec } from '@nomi-ai/gateway';

/** 按顺序登记（顺序 = 旧版共享令牌认身份的顺序）；返回登记了的客户端 id */
export function registerPluginClientSpecs(entries: readonly CliGatewayEntry[]): string[] {
  const ids: string[] = [];
  for (const e of entries) {
    const spec: ClientSpec = e.clientSpec;
    if (spec.id !== e.client) continue;
    registerClientSpec(spec);
    ids.push(spec.id);
  }
  return ids;
}
