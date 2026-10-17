/**
 * AiSdkMcpService — McpService backed by `@ai-sdk/mcp` createMCPClient.
 *
 * On connect: discovers tools, registers them into ToolRegistry (same path as
 * ToolsBuiltin → ChatFacade.agent → AiSdkLlmProvider.withTools → streamText).
 * On disconnect / dispose: unregisters tools and closes the MCP client.
 */
import { createMCPClient, type MCPClient, type MCPClientConfig } from '@ai-sdk/mcp';
import {
  McpKey,
  ToolRegistryKey,
  type McpConnection,
  type McpEvent,
  type McpServerConfig,
  type McpServerInfo,
  type McpService,
  type PluginContext,
  type ToolDefinition,
  type ToolRegistry,
} from '@nomi-ai/bundle-ig-base';
import { jsonSchema } from 'ai';

export type CreateMcpClient = typeof createMCPClient;

export interface AiSdkMcpServiceOptions {
  /** Inject ToolRegistry; if omitted, reads from ctx on each connect. */
  getRegistry: () => ToolRegistry | undefined;
  logger?: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
  /**
   * Prefix tool names with `${serverId}__` to avoid collisions with builtins
   * and across MCP servers. Default true.
   */
  prefixToolNames?: boolean;
  /**
   * 工具注册前的包装钩子（如强制用户确认）。不设置时工具原样注册，
   * 但 dangerous 仍按 inferToolDanger 保守标注。
   */
  guardTool?: McpToolGuard;
  /** Override for tests. */
  createClient?: CreateMcpClient;
  /** 握手（initialize）与 listTools 各自的超时，默认 30s。超时按失败处理并释放子进程 / 连接 */
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** 给一个不一定守时的 promise 加上硬超时（底层 SDK 的超时参数未必对所有 transport 生效） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => timer && clearTimeout(timer));
}

interface LiveServer {
  info: McpServerInfo;
  client: MCPClient;
  toolNames: string[];
}

function toolNameFor(serverId: string, name: string, prefix: boolean): string {
  return prefix ? `${serverId}__${name}` : name;
}

/** 危险工具名片段（保守匹配，命中即按破坏性处理） */
const DANGEROUS_NAME_RE =
  /(^|[_:\-\s])(exec|execute|shell|terminal|console|spawn|run[-_:]?command|delete|remove|rm|write|create|move|copy|install|uninstall|kill|restart|shutdown|reboot|format|chmod|chown|curl|wget|download|upload|send|post|request|fetch)([_:\-\s]|$)/i;

/**
 * 不能盲信远端 MCP annotations：本地（stdio）服务器的非只读工具、以及名字像
 * 命令执行 / 文件写 / 网络发送的工具，一律按破坏性（dangerous）处理。
 */
export function inferToolDanger(
  tool: { name: string; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } },
  transport: McpServerConfig['transport'],
): boolean {
  if (tool.annotations?.destructiveHint === true) return true;
  const readOnly = tool.annotations?.readOnlyHint === true;
  if (readOnly) return false;
  if (transport === 'stdio') return true;
  return DANGEROUS_NAME_RE.test(tool.name);
}

/** 在 MCP 工具注册进 ToolRegistry 前做一次包装（例如强制用户确认） */
export type McpToolGuard = (server: McpServerConfig, def: ToolDefinition) => ToolDefinition;

/** Normalize MCP callTool payload into something models can read. */
export function formatMcpToolResult(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): unknown {
  if (result.isError) {
    const msg =
      result.content
        ?.filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n') || 'MCP tool returned an error';
    throw new Error(msg);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string);
  if (texts.length === 1) return texts[0];
  if (texts.length > 1) return texts.join('\n');
  return result.content ?? null;
}

export async function buildTransport(cfg: McpServerConfig): Promise<{
  transport: MCPClientConfig['transport'];
  displayUrl: string;
}> {
  const transport = cfg.transport === 'websocket' ? 'http' : cfg.transport;

  if (transport === 'http' || transport === 'sse') {
    const url = cfg.url?.trim();
    if (!url) throw new Error(`MCP server '${cfg.id}': url required for ${transport}`);
    if (cfg.transport === 'websocket' && !/^https?:\/\//i.test(url)) {
      throw new Error(
        `MCP server '${cfg.id}': websocket without http(s) url is not supported; use http/sse/stdio`,
      );
    }
    return {
      transport: { type: transport, url, headers: cfg.headers },
      displayUrl: url,
    };
  }

  if (transport === 'stdio') {
    const command = cfg.command?.trim();
    if (!command) throw new Error(`MCP server '${cfg.id}': command required for stdio`);
    const { Experimental_StdioMCPTransport } = await import('@ai-sdk/mcp/mcp-stdio');
    return {
      transport: new Experimental_StdioMCPTransport({
        command,
        args: cfg.args,
        env: cfg.env,
      }),
      displayUrl: [command, ...(cfg.args ?? [])].join(' '),
    };
  }

  throw new Error(`MCP server '${cfg.id}': unsupported transport '${cfg.transport}'`);
}

export class AiSdkMcpService implements McpService {
  private readonly servers = new Map<string, LiveServer>();
  private readonly listeners = new Map<McpEvent, Set<(info: McpServerInfo) => void>>();
  private readonly opts: Required<Pick<AiSdkMcpServiceOptions, 'getRegistry' | 'prefixToolNames'>> &
    AiSdkMcpServiceOptions;

  constructor(opts: AiSdkMcpServiceOptions) {
    this.opts = {
      prefixToolNames: true,
      ...opts,
    };
  }

  listServers(): McpServerInfo[] {
    return [...this.servers.values()].map((s) => ({
      ...s.info,
      toolNames: [...s.toolNames],
    }));
  }

  async connect(cfg: McpServerConfig): Promise<McpConnection> {
    if (this.servers.has(cfg.id)) {
      await this.disconnect(cfg.id);
    }

    const createClient = this.opts.createClient ?? createMCPClient;
    const timeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const registry = this.opts.getRegistry();
    const prefix = this.opts.prefixToolNames !== false;
    const toolNames: string[] = [];
    let client: MCPClient | undefined;
    let builtTransport: MCPClientConfig['transport'] | undefined;
    let displayUrl: string;

    try {
      const built = await buildTransport(cfg);
      builtTransport = built.transport;
      displayUrl = built.displayUrl;
      // initializationOptions.timeout：SDK 超时会自行关闭 transport；下面的硬超时兜底
      // （此时 client 尚未返回，由 finally 式清理里的 transport.close() 终止 stdio 子进程）
      client = await withTimeout(
        createClient({ transport: built.transport, initializationOptions: { timeout: timeoutMs } }),
        timeoutMs + 1_000,
        `mcp connect (${cfg.id})`,
      );

      const listed = await withTimeout(
        client.listTools({ options: { timeout: timeoutMs } }),
        timeoutMs,
        `mcp listTools (${cfg.id})`,
      );
      const live = client;

      for (const t of listed.tools ?? []) {
        const registeredName = toolNameFor(cfg.id, t.name, prefix);
        const mcpName = t.name;
        const inputSchema = (t.inputSchema ?? { type: 'object', properties: {} }) as Record<
          string,
          unknown
        >;
        if (!inputSchema.type) inputSchema.type = 'object';

        const def: ToolDefinition = {
          name: registeredName,
          description: t.description ?? t.title ?? registeredName,
          input: jsonSchema(inputSchema as never),
          dangerous: inferToolDanger(t, cfg.transport),
          readOnly: t.annotations?.readOnlyHint === true,
          execute: async (input, { signal }) => {
            const result = await live.callTool({
              name: mcpName,
              arguments: (input ?? {}) as Record<string, unknown>,
              options: signal ? { signal } : undefined,
            });
            return formatMcpToolResult(result as never);
          },
        };

        const registered = this.opts.guardTool ? this.opts.guardTool(cfg, def) : def;

        if (!registry) {
          this.opts.logger?.warn(
            `MCP tools discovered but ToolRegistry missing; skip register (${registeredName})`,
          );
        } else {
          registry.register(registered);
        }
        toolNames.push(registeredName);
      }
    } catch (err) {
      // 握手 / listTools / 注册任一步失败或超时：撤销已注册的工具，关闭 client 与 transport
      //（stdio 的 transport.close() 会中止子进程；否则失败的 server 会留下僵尸子进程）
      for (const name of toolNames) registry?.unregister?.(name);
      await client?.close().catch(() => undefined);
      const t = builtTransport as { close?: () => Promise<void> | void } | undefined;
      if (t && typeof t.close === 'function') {
        await Promise.resolve(t.close()).catch(() => undefined);
      }
      throw err;
    }

    const info: McpServerInfo = {
      id: cfg.id,
      name: cfg.name,
      url: displayUrl,
      connected: true,
      toolNames: [...toolNames],
    };
    this.servers.set(cfg.id, { info, client: client!, toolNames });
    this.fire('server:up', info);
    this.opts.logger?.info(`mcp connected: ${cfg.id} (tools: ${toolNames.join(', ') || 'none'})`);

    return {
      serverId: cfg.id,
      disconnect: async () => this.disconnect(cfg.id),
    };
  }

  async disconnect(id: string): Promise<void> {
    const live = this.servers.get(id);
    if (!live) return;
    const registry = this.opts.getRegistry();
    for (const name of live.toolNames) {
      registry?.unregister?.(name);
    }
    try {
      await live.client.close();
    } catch (err) {
      this.opts.logger?.warn(`mcp client close failed: ${id}`, err);
    }
    live.info.connected = false;
    this.servers.delete(id);
    this.fire('server:down', live.info);
  }

  on(evt: McpEvent, fn: (info: McpServerInfo) => void): () => void {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(fn);
    return () => this.listeners.get(evt)?.delete(fn);
  }

  async dispose(): Promise<void> {
    for (const id of [...this.servers.keys()]) {
      await this.disconnect(id);
    }
  }

  private fire(evt: McpEvent, info: McpServerInfo): void {
    this.listeners.get(evt)?.forEach((fn) => {
      try {
        fn(info);
      } catch {
        /* ignore */
      }
    });
  }
}

/** Provide AiSdkMcpService on ctx (idempotent). */
export function provideAiSdkMcpService(
  ctx: PluginContext,
  opts?: Partial<AiSdkMcpServiceOptions>,
): AiSdkMcpService {
  const existing = ctx.inject(McpKey);
  if (existing instanceof AiSdkMcpService) return existing;

  const svc = new AiSdkMcpService({
    getRegistry: () => ctx.inject(ToolRegistryKey),
    logger: ctx.logger,
    ...opts,
  });
  ctx.provide(McpKey, svc);
  return svc;
}
