/**
 * 各 CLI 的用户配置目录（尊重各自的目录环境变量，`~` 开头按用户主目录展开）。
 * 只给插件的 main 入口用（依赖 node:path）。
 */
import path from 'node:path';

function expand(v: string | undefined, home: string): string | undefined {
  const s = v?.trim();
  if (!s) return undefined;
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return path.resolve(s);
}

/** 目录环境变量的值，没设时用主目录下的默认目录（如 ~/.claude） */
export function cliHome(
  envVar: string,
  fallback: string,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  return expand(env[envVar], home) ?? path.join(home, fallback);
}

/** Gemini：GEMINI_CLI_HOME 指向「放 .gemini 的主目录」，没设就是用户主目录 */
export function geminiRoot(env: NodeJS.ProcessEnv, home: string): string {
  return expand(env.GEMINI_CLI_HOME, home) ?? home;
}
