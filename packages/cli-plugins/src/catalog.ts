/**
 * @nomi-ai/cli-plugins/catalog：内置编程助手的纯数据目录（清单、界面信息、id、权限档位与终端信息）。
 * 只有纯数据与纯函数，视图包只能 import 这个子路径（lint 强制，docs/design/core-host-decoupling.md §3.2）；
 * 主进程实现在 `./main` 与各 CLI 的 `<cli>/main` 子路径。
 */
import type { CliManifest } from '@nomi-ai/cli-sdk';

import { manifest as claude } from './claude/manifest';
import { renderer as claudeRenderer } from './claude/renderer';
import { manifest as codex } from './codex/manifest';
import { renderer as codexRenderer } from './codex/renderer';
import { manifest as dsh } from './dsh/manifest';
import { renderer as dshRenderer } from './dsh/renderer';
import { manifest as gemini } from './gemini/manifest';
import { renderer as geminiRenderer } from './gemini/renderer';
import { BUILTIN_CLI_IDS, type BuiltinCliId } from './generated/ids';
import { manifest as grok } from './grok/manifest';
import { renderer as grokRenderer } from './grok/renderer';
import type { CliRendererInfo } from './shared/renderer';

export { BUILTIN_CLI_IDS, type BuiltinCliId };
export type { CliRendererInfo };
export * from './shared/permissions';
export * from './shared/terminal';

/**
 * 编程助手 id：内置的是 BuiltinCliId；外部声明式插件（P10）的 id 也是字符串，
 * 所以 CliId 接受任意字符串，同时保留内置 id 的补全。
 */
export type CliId = BuiltinCliId | (string & {});

export function isBuiltinCliId(v: unknown): v is BuiltinCliId {
  return typeof v === 'string' && (BUILTIN_CLI_IDS as readonly string[]).includes(v);
}

export const BUILTIN_MANIFESTS: Readonly<Record<BuiltinCliId, CliManifest>> = {
  claude,
  codex,
  dsh,
  gemini,
  grok,
};

export const BUILTIN_RENDERER: Readonly<Record<BuiltinCliId, CliRendererInfo>> = {
  claude: claudeRenderer,
  codex: codexRenderer,
  dsh: dshRenderer,
  gemini: geminiRenderer,
  grok: grokRenderer,
};
