/**
 * `mcp` 事件源（§6.2、connections.md §6）：定时调用用户已装的本机 MCP 服务器的一个**只读**工具，
 * 把结果里的新条目当事件。邮件、日历、Jira……由用户自己的 MCP 服务器提供，不需要我们逐个写适配器。
 *
 * - 工具必须在任务授权里（连接 `mcp:<服务器>`，能力 `mcp.read`，资源里写了这个工具），且标了 readOnlyHint；
 * - 结果解析：JSON 数组（或对象里第一个数组字段）按条目的 id / key / uid / url 去重，没有就按条目内容哈希；
 *   不是列表就比整段文字的哈希（有变化 = 一件事）；第一次拉当基线；
 * - 只接本机 stdio 服务器（远程 MCP 不在 2.1.0 范围）；最短 5 分钟一次。
 *
 * Go 版：apps/desktop-go/internal/core/tasks/event_mcp.go。
 */
import { createHash } from 'node:crypto';

import { mcpGranted } from '../../../connections/catalog';
import { t } from '../../../i18n';
import type { EventSource, SourceEvent } from '../types';

export interface McpFilter {
  server: string;
  tool: string;
  /** 调用参数（JSON 对象） */
  args?: Record<string, unknown>;
}

export interface McpPort {
  /** 工具信息；服务器不在线时 null；远程服务器 remote */
  info(server: string, tool: string): { readOnly: boolean; remote?: boolean } | null;
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_ITEMS = 200;
const MAX_ARGS = 4000;

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

/** MCP 工具结果 → 文本（已格式化成字符串的直接用；structuredContent 等对象转 JSON） */
export function resultText(out: unknown): string {
  if (typeof out === 'string') return out;
  return JSON.stringify(out ?? null);
}

/** 结果里的条目：JSON 数组，或对象里第一个数组字段；不是列表返回 null */
export function resultItems(text: string): unknown[] | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object')
    for (const x of Object.values(v as Record<string, unknown>)) if (Array.isArray(x)) return x;
  return null;
}

export function itemKey(item: unknown): string {
  if (item && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    for (const k of ['id', 'key', 'uid', 'url', 'link'])
      if (typeof o[k] === 'string' || typeof o[k] === 'number') return String(o[k]);
  }
  return hash(JSON.stringify(item));
}

function itemTitle(item: unknown): string {
  if (item && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    for (const k of ['title', 'subject', 'name', 'summary'])
      if (typeof o[k] === 'string' && o[k]) return (o[k] as string).slice(0, 120);
  }
  return (typeof item === 'string' ? item : JSON.stringify(item)).slice(0, 120);
}

export function createMcpSource(port: McpPort, deps: { now?: () => number } = {}): EventSource {
  const now = deps.now ?? Date.now;
  return {
    id: 'mcp',
    minIntervalMs: 5 * 60_000,
    validate(filter, task) {
      const f = filter as McpFilter | null;
      if (!f || typeof f.server !== 'string' || !ID.test(f.server)) return 'server required';
      if (typeof f.tool !== 'string' || !ID.test(f.tool)) return 'tool required';
      if (f.args !== undefined) {
        if (!f.args || typeof f.args !== 'object' || Array.isArray(f.args)) return 'bad args';
        if (JSON.stringify(f.args).length > MAX_ARGS) return 'args too long';
      }
      const info = port.info(f.server, f.tool);
      if (info?.remote) return `remote MCP server is not supported: ${f.server}`;
      if (info && !info.readOnly) return `tool is not read-only: ${f.tool}`;
      if (mcpGranted(task.grant.connections, f.server, f.tool, true) !== 'read')
        return `tool not granted: ${f.server}/${f.tool}`;
      return null;
    },
    async poll(filter, cursor, ctx) {
      const f = filter as McpFilter;
      const info = port.info(f.server, f.tool);
      if (!info) throw new Error(`MCP tool not connected: ${f.server}/${f.tool}`);
      if (!info.readOnly || info.remote) throw new Error(`tool is not read-only: ${f.tool}`);
      const text = resultText(await port.call(f.server, f.tool, f.args ?? {}, ctx.signal));
      const items = resultItems(text);
      const label = `${f.server}/${f.tool}`;
      const events: SourceEvent[] = [];
      if (items) {
        // 条目靠 hub 的 seen 去重；第一次拉由 hub 当基线
        for (const it of items.slice(0, MAX_ITEMS))
          events.push({
            key: `mcp:${label}:${itemKey(it)}`,
            occurredAt: now(),
            summary: t('electron.common.task-event-mcp-item', label, itemTitle(it)),
            payload: { server: f.server, tool: f.tool, item: it },
          });
        return { events, cursor: cursor ?? 'primed' };
      }
      const h = hash(text);
      if (cursor && cursor !== 'primed' && cursor !== h)
        events.push({
          key: `mcp:${label}:${h}`,
          occurredAt: now(),
          summary: t('electron.common.task-event-mcp-changed', label),
          payload: { server: f.server, tool: f.tool, text: text.slice(0, 4000) },
        });
      return { events, cursor: h, ...(cursor ? {} : { baseline: true }) };
    },
  };
}
