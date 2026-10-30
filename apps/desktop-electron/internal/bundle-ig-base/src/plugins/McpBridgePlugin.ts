import {
  McpKey,
  type McpConnection,
  type McpEvent,
  type McpServerConfig,
  type McpServerInfo,
  type McpService,
} from '../seams/mcp';
import { definePlugin, type PluginContext } from '../types/plugin';

export interface McpBridgeConfig {
  servers?: McpServerConfig[];
  /**
   * 是否在启动时自动 connect。默认为 false —— 让上层按需拉起。
   */
  autoConnect?: boolean;
}

/**
 * Default skeleton: registers server metadata only.
 * Production AI SDK path injects `AiSdkMcpService` (`@ai-sdk/mcp`) via
 * AiSdkMcpPlugin before this plugin; connect() then discovers tools into
 * ToolRegistry for ChatFacade.agent / streamText withTools.
 * Stdio remains Node/Electron-only.
 */
class SkeletonMcpService implements McpService {
  private readonly servers = new Map<string, McpServerInfo>();
  private readonly listeners = new Map<McpEvent, Set<(info: McpServerInfo) => void>>();

  listServers(): McpServerInfo[] {
    return [...this.servers.values()];
  }

  async connect(cfg: McpServerConfig): Promise<McpConnection> {
    // TODO(P3): 真实握手（stdio via child_process / sse via EventSource / ws）
    const info: McpServerInfo = {
      id: cfg.id,
      name: cfg.name,
      url: cfg.url ?? cfg.command ?? '',
      connected: true,
    };
    this.servers.set(cfg.id, info);
    this.fire('server:up', info);
    return {
      serverId: cfg.id,
      disconnect: async () => this.disconnect(cfg.id),
    };
  }

  async disconnect(id: string): Promise<void> {
    const info = this.servers.get(id);
    if (!info) return;
    info.connected = false;
    this.fire('server:down', info);
    this.servers.delete(id);
  }

  on(evt: McpEvent, fn: (info: McpServerInfo) => void): () => void {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(fn);
    return () => this.listeners.get(evt)?.delete(fn);
  }

  private fire(evt: McpEvent, info: McpServerInfo): void {
    this.listeners.get(evt)?.forEach((fn) => {
      try {
        fn(info);
      } catch {
        /* ignore listener errors */
      }
    });
  }
}

export const McpBridgePlugin = definePlugin<McpBridgeConfig>({
  name: 'McpBridgePlugin',
  apply(ctx: PluginContext, cfg: McpBridgeConfig) {
    const existing = ctx.inject(McpKey);
    const svc = existing ?? new SkeletonMcpService();
    if (!existing) ctx.provide(McpKey, svc);

    svc.on('server:up', (info) => ctx.emit('server:up', info));
    svc.on('server:down', (info) => ctx.emit('server:down', info));

    if (cfg.autoConnect) {
      for (const s of cfg.servers ?? []) {
        svc
          .connect(s)
          .then(() => ctx.logger.info(`mcp connected: ${s.id}`))
          .catch((err) => ctx.logger.error(`mcp connect failed: ${s.id}`, err));
      }
    }

    ctx.logger.info(`mcp bridge ready (servers: ${(cfg.servers ?? []).length})`);
  },
});
