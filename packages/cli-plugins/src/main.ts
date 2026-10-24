/**
 * 主进程入口：全部内置插件（清单 + 主进程实现工厂）。只能在主进程 import（依赖 node:*）。
 */
import type { CliPlugin } from '@nomi-ai/cli-sdk';

import { plugin as claude } from './claude/main';
import { plugin as codex } from './codex/main';
import { plugin as dsh } from './dsh/main';
import { plugin as gemini } from './gemini/main';
import type { BuiltinCliId } from './generated/ids';
import { plugin as grok } from './grok/main';

export const BUILTIN_PLUGINS: Readonly<Record<BuiltinCliId, CliPlugin>> = {
  claude,
  codex,
  dsh,
  gemini,
  grok,
};

// 与 CLI 无关的纯函数（档位降级 / 原生模式映射、终端命令转义），主进程也从这里取
export * from './shared/permissions';
export * from './shared/terminal';
export { BUILTIN_CLI_IDS, type BuiltinCliId } from './generated/ids';

export * as claude from './claude/main';
export * as codex from './codex/main';
export * as dsh from './dsh/main';
export * as gemini from './gemini/main';
export * as grok from './grok/main';
