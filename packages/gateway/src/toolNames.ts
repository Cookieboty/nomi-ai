/**
 * 工具名映射（docs/design/unified-gateway.md §12.7.3「工具名」）。
 * Chat Completions 上游要求工具名匹配 ^[a-zA-Z0-9_-]{1,64}$：Codex 的命名空间工具（含 `.`）、
 * 超长的 MCP 工具名发过去会 400。请求方向把不合法的名字换成合法名字，回程按映射表还原。
 *
 * 映射只取决于原名本身（非法字符换成 `_`，截断后加原名的短哈希），所以同一个请求的
 * 请求方向与响应方向各自计算也一定一致，不需要在两者之间传状态。
 */
import { createHash } from 'node:crypto';

import type { Wire } from './ir';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const LEGAL = /^[a-zA-Z0-9_-]{1,64}$/;

export function isLegalChatToolName(name: string): boolean {
  return LEGAL.test(name);
}

/** 合法名字原样返回；否则换成 `<清理后的前 56 个字符>_<7 位哈希>`（最长 64） */
export function chatToolName(name: string): string {
  if (LEGAL.test(name)) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 7);
  const base = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56);
  return `${base || 'tool'}_${hash}`;
}

/** 入口请求体里声明的工具名（四种协议） */
export function ingressToolNames(wire: Wire, body: unknown): string[] {
  const tools = isObj(body) ? body.tools : undefined;
  if (!Array.isArray(tools)) return [];
  const out: string[] = [];
  for (const t of tools) {
    if (!isObj(t)) continue;
    if (wire === 'chat') {
      if (isObj(t.function) && typeof t.function.name === 'string') out.push(t.function.name);
    } else if (wire === 'gemini') {
      for (const d of Array.isArray(t.functionDeclarations) ? t.functionDeclarations : [])
        if (isObj(d) && typeof d.name === 'string') out.push(d.name);
    } else if (typeof t.name === 'string') out.push(t.name);
  }
  return out;
}

/** 映射后的名字 → 原名；没有需要映射的名字时返回 null */
export function chatToolNameReverse(names: Iterable<string>): Map<string, string> | null {
  const m = new Map<string, string>();
  for (const n of names) {
    const mapped = chatToolName(n);
    if (mapped !== n) m.set(mapped, n);
  }
  return m.size ? m : null;
}

/**
 * 发给 Chat 上游的请求体：tools、tool_choice、历史 assistant 消息里的 tool_calls、
 * tool 消息的 name 都换成合法名字。原地改 o（调用方传入的是浅拷贝），只复制被改动的那一层。
 */
export function mapChatToolNames(o: Obj, notes?: string[]): void {
  const mapped = new Set<string>();
  const fnMap = (fn: unknown): unknown => {
    if (!isObj(fn) || typeof fn.name !== 'string') return fn;
    const n = chatToolName(fn.name);
    if (n === fn.name) return fn;
    mapped.add(fn.name);
    return { ...fn, name: n };
  };
  if (Array.isArray(o.tools)) {
    let changed = false;
    const tools = o.tools.map((t) => {
      if (!isObj(t)) return t;
      const fn = fnMap(t.function);
      if (fn === t.function) return t;
      changed = true;
      return { ...t, function: fn };
    });
    if (changed) o.tools = tools;
  }
  if (isObj(o.tool_choice) && isObj(o.tool_choice.function)) {
    const fn = fnMap(o.tool_choice.function);
    if (fn !== o.tool_choice.function) o.tool_choice = { ...o.tool_choice, function: fn };
  }
  if (Array.isArray(o.messages)) {
    let changed = false;
    const messages = o.messages.map((m) => {
      if (!isObj(m)) return m;
      let next = m;
      if (Array.isArray(m.tool_calls)) {
        let callsChanged = false;
        const calls = m.tool_calls.map((tc) => {
          if (!isObj(tc)) return tc;
          const fn = fnMap(tc.function);
          if (fn === tc.function) return tc;
          callsChanged = true;
          return { ...tc, function: fn };
        });
        if (callsChanged) next = { ...next, tool_calls: calls };
      }
      if (m.role === 'tool' && typeof m.name === 'string') {
        const n = chatToolName(m.name);
        if (n !== m.name) {
          mapped.add(m.name);
          next = { ...next, name: n };
        }
      }
      if (next !== m) changed = true;
      return next;
    });
    if (changed) o.messages = messages;
  }
  if (mapped.size) notes?.push(`${mapped.size} 个工具名已映射为 Chat 接口允许的名字`);
}
