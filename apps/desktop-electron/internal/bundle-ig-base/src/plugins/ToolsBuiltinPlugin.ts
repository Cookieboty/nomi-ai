import { ToolRegistryKey, type ToolRegistry } from '../seams/tools';
import type { ToolDefinition } from '../types/common';
import { definePlugin, type PluginContext } from '../types/plugin';

import { createHttpGetReadonlyTool, echoTool, randomTool, timeNowTool } from './tools/builtin';

export type BuiltinToolName = 'time_now' | 'random' | 'echo' | 'http_get_readonly';

export interface ToolsBuiltinConfig {
  enable: BuiltinToolName[];
  http_get_readonly?: {
    allowHosts?: string[];
    maxContentLength?: number;
  };
}

class InMemoryToolRegistry implements ToolRegistry {
  private readonly map = new Map<string, ToolDefinition>();
  register<TInput = unknown, TOutput = unknown>(tool: ToolDefinition<TInput, TOutput>): void {
    this.map.set(tool.name, tool as ToolDefinition);
  }
  get(name: string): ToolDefinition | undefined {
    return this.map.get(name);
  }
  list(): ToolDefinition[] {
    return [...this.map.values()];
  }
  unregister(name: string): boolean {
    return this.map.delete(name);
  }
}

export const ToolsBuiltinPlugin = definePlugin<ToolsBuiltinConfig>({
  name: 'ToolsBuiltinPlugin',
  apply(ctx: PluginContext, cfg: ToolsBuiltinConfig) {
    // 允许上游已经 provide 过 registry（P1 插件宿主 官方版本），否则本地兜底
    const existing = ctx.inject(ToolRegistryKey);
    const registry: ToolRegistry = existing ?? new InMemoryToolRegistry();
    if (!existing) ctx.provide(ToolRegistryKey, registry);

    const enable = new Set<BuiltinToolName>(cfg.enable ?? []);

    if (enable.has('time_now')) registry.register(timeNowTool);
    if (enable.has('random')) registry.register(randomTool);
    if (enable.has('echo')) registry.register(echoTool);
    if (enable.has('http_get_readonly')) {
      registry.register(
        createHttpGetReadonlyTool({
          allowHosts: cfg.http_get_readonly?.allowHosts ?? [],
          maxContentLength: cfg.http_get_readonly?.maxContentLength,
        }),
      );
    }

    ctx.logger.info(
      `builtin tools registered: ${registry
        .list()
        .map((t) => t.name)
        .join(', ')}`,
    );
  },
});
