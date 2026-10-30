import { defineService } from '../types/plugin';

export interface McpServerInfo {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  /** Tool names registered into ToolRegistry for this server (when bridge is live). */
  toolNames?: string[];
}

export interface McpServerConfig {
  id: string;
  name: string;
  /**
   * Transport:
   * - `http` — Streamable HTTP (recommended; @ai-sdk/mcp)
   * - `sse` — Server-Sent Events
   * - `stdio` — local child process (dev / desktop only)
   * - `websocket` — treated as `http` when `url` is http(s); otherwise unsupported
   */
  transport: 'stdio' | 'sse' | 'websocket' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Optional HTTP/SSE headers (e.g. Authorization). */
  headers?: Record<string, string>;
}

export interface McpConnection {
  serverId: string;
  disconnect(): Promise<void>;
}

export type McpEvent = 'server:up' | 'server:down';

export interface McpService {
  listServers(): McpServerInfo[];
  connect(cfg: McpServerConfig): Promise<McpConnection>;
  disconnect(id: string): Promise<void>;
  on(evt: McpEvent, fn: (info: McpServerInfo) => void): () => void;
}

export const McpKey = defineService<McpService>('ctx.mcp');
