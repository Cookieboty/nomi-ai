/**
 * 解析输入框里的斜杠命令。
 *
 * 规则（刻意保守，避免误伤普通文字）：
 * - 只认**整条消息开头**的 `/name`；`name` 只能是字母 / 数字 / `_ - : .`
 *   （含 `/` 的像路径 `/usr/bin` 一律当普通文字）。
 * - `//xxx` 是转义：作为普通文字 `/xxx` 发送。
 * - 命令名之后的所有内容（含换行）都是参数。
 */

export interface ParsedSlash {
  name: string;
  args: string;
  /** 用户输入的原文（去掉首尾空白） */
  raw: string;
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

export type ParseResult =
  { type: 'command'; value: ParsedSlash } | { type: 'escaped'; text: string } | { type: 'text' };

export function parseSlashInput(input: string): ParseResult {
  if (!input.startsWith('/')) return { type: 'text' };
  if (input.startsWith('//')) return { type: 'escaped', text: input.slice(1) };
  const m = /^\/(\S*)([\s\S]*)$/.exec(input);
  if (!m) return { type: 'text' };
  const name = m[1]!;
  if (!name || !NAME.test(name)) return { type: 'text' };
  return {
    type: 'command',
    value: { name, args: m[2]!.trim(), raw: input.trim() },
  };
}

/** 输入框是否处于「正在输入命令名」阶段（还没打空格）；返回查询串（不含 `/`） */
export function paletteQuery(input: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(input);
  return m ? m[1]! : null;
}

/** 输入框是否处于「命令名已定、正在输参数」阶段；返回命令名与当前参数 */
export function argPhase(input: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9_][A-Za-z0-9_.:-]*)\s([\s\S]*)$/.exec(input);
  return m ? { name: m[1]!, args: m[2]! } : null;
}
