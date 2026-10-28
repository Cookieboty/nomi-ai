/**
 * 官方账号的钥匙串条目命名（只用于删除残留条目，从不读取内容）。
 *
 * 旧版本这里有读写各 CLI 凭据的适配器（保险箱 + 全局切换）；Anthropic 不允许第三方收集、存储或中转
 * Claude.ai 凭据，现改为「一个账号一个配置目录、登录由 CLI 自己完成」
 * （docs/design/cli-plugin-architecture.md §5.10），凭据读写代码已删除（S7）。
 */
import { createHash } from 'node:crypto';
import os from 'node:os';

/** Claude 在 macOS 钥匙串里的服务名：设了 CLAUDE_CONFIG_DIR 时追加目录的 sha256 前 8 位（2.1.303 源码） */
export function claudeKeychainService(env: NodeJS.ProcessEnv, configDir: string): string {
  const base = 'Claude Code-credentials';
  if (!env.CLAUDE_CONFIG_DIR) return base;
  return `${base}-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}`;
}

export function claudeAccountName(env: NodeJS.ProcessEnv): string {
  let name: string;
  try {
    name = env.USER || os.userInfo().username;
  } catch {
    name = 'claude-code-user';
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
}
