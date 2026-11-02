/**
 * 连接的能力目录（docs/design/connections.md §2）：每项能力的副作用范围与最低授权等级。
 *
 * - `github.read` / `mcp.read` 只读（L1）；`github.comment` / `github.pr.create` / `mcp.call` 是对外动作（L4），
 *   执行前先写 intent、成功后写 done（persistent-tasks.md §10.2）；
 * - 本机 MCP 服务器是虚拟连接 `mcp:<服务器 id>`：只接用户已配好的 stdio 服务器，不另存（connections.md §6）。
 *   `mcp.read` 只能给标了 readOnlyHint 的工具；其它工具一律按对外动作（`mcp.call`）；resources 是工具名；
 * - 合并、发布这类能力永不授予。
 *
 * Go 版：apps/desktop-go/internal/core/connections/catalog.go，两边逐条一致。
 */
import { isRepo } from './github';

export type Effect = 'none' | 'local' | 'external';

export interface CapabilitySpec {
  effect: Effect;
  /** 最低授权等级 */
  level: 0 | 1 | 2 | 3 | 4;
  /** 只能用于哪类连接 */
  provider: 'github' | 'mcp';
}

export const CAPABILITIES: Readonly<Record<string, CapabilitySpec>> = {
  'github.read': { effect: 'none', level: 1, provider: 'github' },
  'github.comment': { effect: 'external', level: 4, provider: 'github' },
  'github.pr.create': { effect: 'external', level: 4, provider: 'github' },
  'mcp.read': { effect: 'none', level: 1, provider: 'mcp' },
  'mcp.call': { effect: 'external', level: 4, provider: 'mcp' },
};

/** 永不授予（每次都由人决定） */
export const NEVER_CAPABILITIES: readonly string[] = [
  'github.merge',
  'github.release',
  'github.delete',
];

export const MCP_CONNECTION_PREFIX = 'mcp:';

export const mcpConnectionId = (serverId: string) => `${MCP_CONNECTION_PREFIX}${serverId}`;

export const mcpServerOf = (connectionId: string): string | null =>
  connectionId.startsWith(MCP_CONNECTION_PREFIX)
    ? connectionId.slice(MCP_CONNECTION_PREFIX.length) || null
    : null;

/** MCP 工具在注册表里的名字：`<服务器 id>__<工具名>` */
export function splitMcpTool(name: string): { serverId: string; tool: string } | null {
  const i = name.indexOf('__');
  if (i <= 0 || i + 2 >= name.length) return null;
  return { serverId: name.slice(0, i), tool: name.slice(i + 2) };
}

export const isExternalCapability = (cap: string) => CAPABILITIES[cap]?.effect === 'external';

const TOOL = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface GrantConnectionLike {
  connectionId: string;
  capabilities: readonly string[];
  resources: readonly string[];
}

/**
 * 授权里的连接项是否合法：能力在目录里、和连接类型对得上、等级够；资源必须写明（没有通配）。
 * `mcpTool` 给出时检查 `mcp.read` 只用于只读工具（工具不在线时不检查，调用时再按授权收窄）。
 */
export function validateConnectionGrants(
  grants: readonly GrantConnectionLike[],
  level: number,
  mcpTool?: (serverId: string, tool: string) => { readOnly: boolean; remote?: boolean } | null,
): string | null {
  for (const g of grants) {
    const server = mcpServerOf(g.connectionId);
    const provider = server ? 'mcp' : 'github';
    if (!g.capabilities.length) return `no capabilities for ${g.connectionId}`;
    if (!g.resources.length) return `no resources for ${g.connectionId}`;
    for (const cap of g.capabilities) {
      if (NEVER_CAPABILITIES.includes(cap)) return `capability is never granted: ${cap}`;
      const spec = CAPABILITIES[cap];
      if (!spec) return `unknown capability: ${cap}`;
      if (spec.provider !== provider)
        return `capability ${cap} does not apply to ${g.connectionId}`;
      if (level < spec.level) return `capability ${cap} needs level ${spec.level}`;
    }
    for (const r of g.resources) {
      if (r.includes('*')) return `wildcard resource: ${r}`;
      if (provider === 'github' && !isRepo(r)) return `bad repo: ${r}`;
      if (provider === 'mcp' && !TOOL.test(r)) return `bad tool: ${r}`;
    }
    if (server && mcpTool && g.resources.some((r) => mcpTool(server, r)?.remote))
      return `remote MCP server is not supported: ${server}`;
    if (
      server &&
      mcpTool &&
      g.capabilities.includes('mcp.read') &&
      !g.capabilities.includes('mcp.call')
    )
      for (const r of g.resources) {
        const info = mcpTool(server, r);
        if (info && !info.readOnly) return `tool ${r} is not read-only; it needs mcp.call`;
      }
  }
  return null;
}

/** 后台任务能不能调这个 MCP 工具：授权里有这个服务器、这个工具，以及对应的能力 */
export function mcpGranted(
  grants: readonly GrantConnectionLike[],
  serverId: string,
  tool: string,
  readOnly: boolean,
): 'read' | 'call' | null {
  const g = grants.find((x) => x.connectionId === mcpConnectionId(serverId));
  if (!g || !g.resources.includes(tool)) return null;
  // 只读工具不论给的是哪项都按只读跑（不写 intent）；其它工具必须给 mcp.call
  if (readOnly && (g.capabilities.includes('mcp.read') || g.capabilities.includes('mcp.call')))
    return 'read';
  return g.capabilities.includes('mcp.call') ? 'call' : null;
}
