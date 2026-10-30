/** 会话标题等文本的清理（历史列表、进度监视共用；从主进程 agents/parsers.ts 搬来） */
import { stripCarriedContext } from '@nomi-ai/cli-sdk';

/** 清理用户提问作为标题：去掉命令包装 / 系统注入，压成一行 */
export function cleanTitle(raw: string | undefined, max = 80): string | undefined {
  if (!raw) return undefined;
  let s = raw;
  // Nomi 换工作目录 / 分叉时带入的前文（cli/contextCarry.ts）：标题取用户原话
  s = stripCarriedContext(s);
  // Claude Code 的 slash 命令包装 / 本地命令输出
  if (/^\s*<(command-name|local-command-stdout|command-message|system-reminder)/.test(s)) {
    const m = /<command-name>([^<]+)<\/command-name>/.exec(s);
    const args = /<command-args>([^<]*)<\/command-args>/.exec(s);
    if (!m) return undefined;
    s = `${m[1]} ${args?.[1] ?? ''}`;
  }
  // Codex 注入的环境 / 指令块
  if (/^\s*<(environment_context|user_instructions|INSTRUCTIONS)/i.test(s)) return undefined;
  if (/^\s*#\s*AGENTS\.md/i.test(s)) return undefined;
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
