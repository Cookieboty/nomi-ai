/**
 * @nomi-ai/cli-catalog：内置编程助手的清单与界面信息（docs/development/coding-agents.md）。
 * 只有纯数据与纯函数（清单、界面信息、id、权限档位、终端命令转义），Node 版与 Go 版共用的视图也 import；
 * 内核实现在 apps/desktop-go/internal/cliplugins。
 */

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
import { manifest as kimi } from './kimi/manifest';
import { renderer as kimiRenderer } from './kimi/renderer';
import type { CliManifest } from './manifest';
import { manifest as minimax } from './minimax/manifest';
import { renderer as minimaxRenderer } from './minimax/renderer';
import type { CliRendererInfo } from './shared/renderer';

export { BUILTIN_CLI_IDS, type BuiltinCliId };
export type { CliRendererInfo };
export * from './manifest';
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
  kimi,
  minimax,
};

/**
 * 界面与名单里的顺序（先来的在前，新加的接在后面）；BUILTIN_CLI_IDS 是按 id 排序的。
 * 与 Go 内核的 builtin.Ordered 一致。
 */
export const BUILTIN_CLI_ORDER: readonly BuiltinCliId[] = [
  'claude',
  'codex',
  'grok',
  'gemini',
  'dsh',
  'kimi',
  'minimax',
];

/** 显示名（「Gemini」）；不是内置的原样返回 */
export function cliName(id: string): string {
  return isBuiltinCliId(id) ? BUILTIN_MANIFESTS[id].displayName : id;
}

/** 完整名称（看板、用量、灵动岛：「Gemini CLI」）；与 Go 内核 builtin.Entry.FullName 一致 */
const FULL_NAME: Partial<Record<BuiltinCliId, string>> = { gemini: 'Gemini CLI' };
export function cliFullName(id: string): string {
  return (isBuiltinCliId(id) && FULL_NAME[id]) || cliName(id);
}

/** 按内置 id 建一张表（顺序同 BUILTIN_CLI_ORDER） */
export function byCli<T>(f: (id: BuiltinCliId) => T): Record<BuiltinCliId, T> {
  return Object.fromEntries(BUILTIN_CLI_ORDER.map((id) => [id, f(id)])) as Record<BuiltinCliId, T>;
}

/** 清单 capabilities 里的布尔能力（officialAccount、thirdParty、usageQuota、terminalCommand……） */
export function cliCapability(id: string, name: keyof CliManifest['capabilities']): boolean {
  return isBuiltinCliId(id) && BUILTIN_MANIFESTS[id].capabilities[name] === true;
}

export const BUILTIN_RENDERER: Readonly<Record<BuiltinCliId, CliRendererInfo>> = {
  claude: claudeRenderer,
  codex: codexRenderer,
  dsh: dshRenderer,
  gemini: geminiRenderer,
  grok: grokRenderer,
  kimi: kimiRenderer,
  minimax: minimaxRenderer,
};
