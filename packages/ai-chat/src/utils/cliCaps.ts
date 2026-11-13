/**
 * 编程助手的能力位（来自内置插件清单，P9.4）：界面按能力决定显示什么，不按 CLI 名字判断。
 * 只读纯数据（@nomi-ai/cli-catalog），不经 IPC。
 */
import {
  BUILTIN_RENDERER,
  cliName,
  isBuiltinCliId,
  type CliRendererInfo,
} from '@nomi-ai/cli-catalog';
import { t } from '@nomi-ai/ui';

import type { AccountKind } from '../services/cliAccountClient';

export function cliInfo(backend: string | null | undefined): CliRendererInfo | null {
  return backend && isBuiltinCliId(backend) ? BUILTIN_RENDERER[backend] : null;
}

/** 有官方账号（登录 / 订阅额度 / 「官方账号」来源）；没有的内置 CLI 只用第三方 */
export function hasOfficialAccount<T extends string>(
  backend: T | null | undefined,
): backend is Extract<T, AccountKind> {
  return cliInfo(backend)?.capabilities.officialAccount === true;
}

/**
 * 只能用第三方模型的内置编程助手（没有官方账号能力的 dsh、Gemini）：不再有「用 CLI 自己的登录 / 配置」这一来源。
 * 内置编程助手只用 Nomi 管理的官方账号或经网关的第三方模型；外部 CLI 不经 Nomi，照旧自己管登录。
 */
export function thirdPartyOnly(backend: string | null | undefined): boolean {
  return !!backend && isBuiltinCliId(backend) && !hasOfficialAccount(backend);
}

/** 外部 CLI 的来源：它自己的配置（Nomi 不管它的登录） */
export function ownConfigLabel(backend: string): string {
  return t('ui.models.cli-own-config', cliName(backend));
}

/** CLI 本身能不能收图（不看模型）；Nomi 自己与未知后端按能收处理 */
export function cliAcceptsImages(backend: string | null | undefined): boolean {
  const info = cliInfo(backend);
  return !info || info.capabilities.images !== 'none';
}

/** 一轮进行中能插入用户消息（不能的运行中发送一律排队到这一轮结束） */
export function canSteer(backend: string | null | undefined): boolean {
  return cliInfo(backend)?.capabilities.steer === true;
}

/** 能单独停止某个子代理（不能时只能停整个标签） */
export function canStopSubagent(backend: string | null | undefined): boolean {
  return cliInfo(backend)?.capabilities.subagentStop === true;
}

/** 能列出命令 / Skills / 插件 / MCP（斜杠发现） */
export function hasSlashCommands(backend: string | null | undefined): boolean {
  return cliInfo(backend)?.capabilities.slashCommands === true;
}
