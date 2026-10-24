/**
 * `/agent 名字` 的参数补全：命令名后敲空格，列出编程助手（来自委派设置里的已安装检测）。
 * 已安装的排前面；没安装的照样列出但不可选。按显示名或 id 前缀过滤（不区分大小写）。
 */
import { t } from '@nomi-ai/ui';

import { DELEGATE_CLIS, type DelegateCli } from '../services/delegateClient';
import { ENDPOINT_NAME } from '../utils/endpointBadge';

import { argPhase } from './parse';
import { findCommand } from './registry';
import type { SlashCommand } from './types';

/** 带编程助手补全的命令（真名；旧名 /cli 经 findCommand 的隐藏别名落到它） */
export const AGENT_COMMAND = 'agent';

export interface AgentOption {
  id: DelegateCli;
  name: string;
  installed: boolean;
}

/**
 * 输入框是否正在输 `/agent` 的第一个参数（助手名）；返回已输入的前缀，否则 null。
 * 已经输完名字、敲了空格在写需求时不再补全。
 */
export function agentArgQuery(input: string, commands: readonly SlashCommand[]): string | null {
  const a = argPhase(input);
  if (!a || /\s/.test(a.args)) return null;
  const c = findCommand(commands, a.name);
  if (!c || c.name !== AGENT_COMMAND || c.source !== 'builtin' || c.disabled) return null;
  return a.args;
}

/** 候选列表：已安装在前（各自保持注册顺序），按前缀过滤 */
export function filterAgents(
  installed: readonly DelegateCli[] | null,
  query: string,
): AgentOption[] {
  const q = query.trim().toLowerCase();
  const all = DELEGATE_CLIS.map((id) => ({
    id,
    name: t(ENDPOINT_NAME[id]),
    installed: !!installed?.includes(id),
  }));
  return all
    .filter((o) => !q || o.id.startsWith(q) || o.name.toLowerCase().startsWith(q))
    .sort((a, b) => Number(b.installed) - Number(a.installed));
}
