/**
 * 官方 CLI 的配置目录：尊重各工具的 HOME 类环境变量（CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME /
 * QWEN_HOME / OPENCODE_HOME / XDG_DATA_HOME / COPILOT_HOME / KIMI_HOME / KIMI_CODE_HOME / GROK_HOME，支持 `~` 与 `~/…`），否则用默认目录。
 * 只算路径，不读任何文件。
 */
import os from 'node:os';
import path from 'node:path';

function expand(value: string | undefined, home: string): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (v === '~') return home;
  if (v.startsWith('~/') || v.startsWith('~\\')) return path.join(home, v.slice(2));
  return path.resolve(v);
}

export function claudeConfigDir(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env) {
  return expand(env.CLAUDE_CONFIG_DIR, home) ?? path.join(home, '.claude');
}

export function codexHomeDir(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env) {
  return expand(env.CODEX_HOME, home) ?? path.join(home, '.codex');
}

type Env = NodeJS.ProcessEnv;

/** Gemini CLI：GEMINI_CLI_HOME 指向「放 .gemini 的主目录」（官方用它覆盖 home）；没设就用用户主目录 */
export function geminiDir(home: string = os.homedir(), env: Env = process.env) {
  return path.join(expand(env.GEMINI_CLI_HOME, home) ?? home, '.gemini');
}

/** Qwen Code：QWEN_HOME 直接指向配置目录（默认 ~/.qwen）；变量名未在真机核对 */
export function qwenDir(home: string = os.homedir(), env: Env = process.env) {
  return expand(env.QWEN_HOME, home) ?? path.join(home, '.qwen');
}

/** OpenCode：OPENCODE_HOME 指向数据目录；否则 $XDG_DATA_HOME/opencode，再否则 ~/.local/share/opencode */
export function opencodeDir(home: string = os.homedir(), env: Env = process.env) {
  return (
    expand(env.OPENCODE_HOME, home) ??
    path.join(expand(env.XDG_DATA_HOME, home) ?? path.join(home, '.local', 'share'), 'opencode')
  );
}

/** Copilot CLI：COPILOT_HOME（默认 ~/.copilot） */
export function copilotDir(home: string = os.homedir(), env: Env = process.env) {
  return expand(env.COPILOT_HOME, home) ?? path.join(home, '.copilot');
}

/** Kimi：旧版 kimi-cli 用 KIMI_HOME（默认 ~/.kimi），Kimi Code 用 KIMI_CODE_HOME（默认 ~/.kimi-code） */
export function kimiDirs(home: string = os.homedir(), env: Env = process.env): string[] {
  return [
    expand(env.KIMI_HOME, home) ?? path.join(home, '.kimi'),
    expand(env.KIMI_CODE_HOME, home) ?? path.join(home, '.kimi-code'),
  ];
}

/** Grok Build：GROK_HOME（默认 ~/.grok）；会话在 sessions/，配置为 config.toml */
export function grokHomeDir(home: string = os.homedir(), env: Env = process.env) {
  return expand(env.GROK_HOME, home) ?? path.join(home, '.grok');
}
