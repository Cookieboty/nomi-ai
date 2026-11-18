/**
 * `/agent 名字` 的参数补全：命令名后敲空格，列出 agent（来自委派设置里的已安装检测）。
 * 已安装的排前面；没安装的照样列出但不可选。按显示名或 id 前缀过滤（不区分大小写）。
 */
import { t } from '@nomi-ai/ui';

import {
  DELEGATE_CLIS,
  formatRunnerSummary,
  presetDisplayLabel,
  type DelegateCli,
  type RunnerPreset,
} from '../services/delegateClient';
import type { GatewayState } from '../services/gatewayClient';
import { ENDPOINT_NAME } from '../utils/endpointBadge';

import { argPhase } from './parse';
import { findCommand } from './registry';
import type { SlashCommand } from './types';

/** 带 agent 补全的命令（真名；旧名 /cli 经 findCommand 的隐藏别名落到它） */
export const AGENT_COMMAND = 'agent';

export interface AgentOption {
  id: string;
  name: string;
  installed: boolean;
  kind?: 'preset' | 'cli';
  cli?: DelegateCli;
  summary?: string;
}

/**
 * 输入框是否正在输 `/agent` 的第一个参数（助手名或档位名）；返回已输入的前缀，否则 null。
 * 已经输完名字、敲了空格在写需求时不再补全。
 */
export function agentArgQuery(input: string, commands: readonly SlashCommand[]): string | null {
  const a = argPhase(input);
  if (!a || /\s/.test(a.args)) return null;
  const c = findCommand(commands, a.name);
  if (!c || c.name !== AGENT_COMMAND || c.source !== 'builtin' || c.disabled) return null;
  return a.args;
}

/** 候选列表：匹配预设排在最前，其后是 CLI（各自已安装在前），按前缀过滤 */
export function filterAgents(
  installed: readonly DelegateCli[] | null,
  query: string,
  presets?: readonly RunnerPreset[],
  gateway?: GatewayState | null,
): AgentOption[] {
  const q = query.trim().toLowerCase();
  const presetOpts: AgentOption[] = (presets ?? [])
    .map((p) => ({ preset: p, displayName: presetDisplayLabel(p) }))
    .filter(
      ({ preset: p, displayName }) =>
        !q ||
        p.id.toLowerCase().startsWith(q) ||
        displayName.toLowerCase().startsWith(q) ||
        p.label.toLowerCase().startsWith(q),
    )
    .map(({ preset: p, displayName }) => ({
      id: p.id,
      name: displayName,
      installed: !!installed?.includes(p.cli),
      kind: 'preset' as const,
      cli: p.cli,
      summary: formatRunnerSummary(p, gateway),
    }))
    .sort((a, b) => Number(b.installed) - Number(a.installed));
  const cliOpts: AgentOption[] = DELEGATE_CLIS.map((id) => ({
    id,
    name: t(ENDPOINT_NAME[id]),
    installed: !!installed?.includes(id),
    kind: 'cli' as const,
  }))
    .filter((o) => !q || o.id.startsWith(q) || o.name.toLowerCase().startsWith(q))
    .sort((a, b) => Number(b.installed) - Number(a.installed));
  return [...presetOpts, ...cliOpts];
}
