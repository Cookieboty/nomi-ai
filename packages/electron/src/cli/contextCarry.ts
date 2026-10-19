/**
 * 换工作目录 / 分叉时把之前的对话带进新的 CLI 会话（docs/design/cli-workspace-switch.md）。
 * CLI 自己的会话与工作目录绑定（Claude 的 projects/<cwd>、Gemini 的 tmp/<项目>），换目录后无法续接；
 * 所以对所有 CLI 统一做法：把可见对话整理成一段前文，在新会话的第一轮放在用户消息前面一起发出。
 * 纯函数，不碰文件系统。
 */
import { t } from '../i18n';

import type { HarnessBackend, HarnessTabMessage } from './types';

/** 最多带多少条消息（从最近的往前） */
export const CARRY_MAX_MESSAGES = 40;
/** 单条消息上限 */
export const CARRY_MAX_CHARS = 4000;
/** 整段前文上限（约 1.5 万 token），超出时丢最早的消息 */
export const CARRY_MAX_TOTAL = 60_000;

export interface CarriedContext {
  text: string;
  /** 带上的消息条数 */
  messages: number;
}

/** 可见对话 → 前文；没有可带的内容时返回 null */
export function buildCarriedContext(
  messages: readonly HarnessTabMessage[],
  fromCwd: string,
): CarriedContext | null {
  const lines: string[] = [];
  for (const m of messages.slice(-CARRY_MAX_MESSAGES * 2)) {
    if (m.error) continue;
    const text = (m.content ?? '').trim();
    if (!text) continue;
    const body = text.length > CARRY_MAX_CHARS ? `${text.slice(0, CARRY_MAX_CHARS)}…` : text;
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${body}`);
  }
  let kept = lines.slice(-CARRY_MAX_MESSAGES);
  while (kept.length > 1 && kept.reduce((n, l) => n + l.length + 1, 0) > CARRY_MAX_TOTAL)
    kept = kept.slice(1);
  if (!kept.length) return null;
  const text = [
    t(
      '[Nomi] 以下是这个对话之前在 {0} 里的内容，工作目录已经换成当前目录。请把它当作上下文继续，不必复述：',
      fromCwd,
    ),
    '<previous_conversation>',
    ...kept,
    '</previous_conversation>',
  ].join('\n');
  return { text, messages: kept.length };
}

const CARRY_END = '</previous_conversation>\n\n---\n\n';

/**
 * 前文能占多少字符，取决于 CLI 怎么收消息：
 * - Claude / Gemini 从 stdin 读（stream-json / ACP），不受命令行长度限制；
 * - Codex / dsh / Grok 把消息放在命令行参数里：Windows 上 npm 装的是 .cmd 垫片，经 cmd.exe 启动，
 *   整条命令行上限 8191 字符；Linux 单个参数上限 128 KB（中文 UTF-8 一个字 3 字节）；macOS 总量约 1 MB。
 */
export function carriedBudget(backend: HarnessBackend, platform: NodeJS.Platform): number {
  if (backend === 'claude' || backend === 'gemini') return CARRY_MAX_TOTAL;
  if (platform === 'win32') return 5000;
  return 30_000;
}

/** 前文超出预算时从最早的消息开始丢；连一条都放不下就不带 */
export function fitCarried(text: string, max: number): string | null {
  if (text.length <= max) return text;
  const open = text.indexOf('<previous_conversation>\n');
  const close = text.lastIndexOf('\n</previous_conversation>');
  if (open < 0 || close < 0) return null;
  const head = text.slice(0, open + '<previous_conversation>\n'.length);
  const tail = text.slice(close);
  // 按消息切：每条以 "User: " / "Assistant: " 开头
  const body = text.slice(head.length, close);
  const parts = body.split(/\n(?=(?:User|Assistant): )/);
  while (parts.length && head.length + parts.join('\n').length + tail.length > max) parts.shift();
  return parts.length ? `${head}${parts.join('\n')}${tail}` : null;
}

/** 从 CLI 落盘的用户消息里去掉 Nomi 带入的前文，只留用户原话（读历史时用） */
export function stripCarriedContext(text: string): string {
  const i = text.indexOf(CARRY_END);
  return i >= 0 && text.trimStart().startsWith('[Nomi]') ? text.slice(i + CARRY_END.length) : text;
}

/** 新会话第一轮实际发给 CLI 的内容：前文 + 用户这条消息 */
export function withCarriedContext(carried: string | null | undefined, prompt: string): string {
  return carried ? `${carried}\n\n---\n\n${prompt}` : prompt;
}
