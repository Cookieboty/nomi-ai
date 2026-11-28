/**
 * 将 ACP available_commands_update / 运行时推送的命令转为统一 SlashCommand。
 */
import type { AcpSlashCommand } from '../services/harnessClient';

import type { SlashCommand } from './types';

export function acpCommandsToSlashCommands(
  list?: readonly AcpSlashCommand[] | null,
): SlashCommand[] {
  if (!list?.length) return [];
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const cmd of list) {
    const name = cmd.name.trim().replace(/^\/+/, '');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `endpoint:${name}`,
      name,
      label: `/${name}`,
      description: cmd.description?.trim() ?? '',
      source: 'endpoint',
      kind: 'passthrough',
      ...(cmd.hint?.trim() ? { args: { hint: cmd.hint.trim() } } : {}),
      run: (args) => {
        const trimmed = args.trim();
        return {
          type: 'send',
          text: trimmed ? `/${name} ${trimmed}` : `/${name}`,
        };
      },
    });
  }
  return out;
}
