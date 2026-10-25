/**
 * 编程助手的能力位（来自内置插件清单，P9.4）：界面按能力决定显示什么，不按 CLI 名字判断。
 * 只读纯数据（@nomi-ai/cli-plugins 的根入口），不经 IPC。
 */
import { BUILTIN_RENDERER, isBuiltinCliId, type CliRendererInfo } from '@nomi-ai/cli-plugins';

import type { AccountKind } from '../services/cliAccountClient';

export function cliInfo(backend: string | null | undefined): CliRendererInfo | null {
  return backend && isBuiltinCliId(backend) ? BUILTIN_RENDERER[backend] : null;
}

/** 有官方账号（登录 / 订阅额度 / 「官方账号」来源）；没有的 CLI 只用自带配置或第三方 */
export function hasOfficialAccount<T extends string>(
  backend: T | null | undefined,
): backend is Extract<T, AccountKind> {
  return cliInfo(backend)?.capabilities.officialAccount === true;
}

/** CLI 本身能不能收图（不看模型）；Nomi 自己与未知后端按能收处理 */
export function cliAcceptsImages(backend: string | null | undefined): boolean {
  const info = cliInfo(backend);
  return !info || info.capabilities.images !== 'none';
}

/** 能单独停止某个子代理（不能时只能停整个标签） */
export function canStopSubagent(backend: string | null | undefined): boolean {
  return cliInfo(backend)?.capabilities.subagentStop === true;
}

/** 能列出命令 / Skills / 插件 / MCP（斜杠发现） */
export function hasSlashCommands(backend: string | null | undefined): boolean {
  return cliInfo(backend)?.capabilities.slashCommands === true;
}
