/** Grok（`grok -p`）：与 Codex 同类——模板 + 本机展开的自定义命令 / skills，其余明确提示 */
import { t } from '@nomi-ai/ui';

import type { AdapterInput, SlashCommand } from '../types';

import {
  discoveredCommands,
  nativeCommands,
  promptTemplates,
  unsupportedCommands,
  U,
} from './common';

export function grokAdapter(input: AdapterInput): SlashCommand[] {
  return [
    ...nativeCommands('grok'),
    ...promptTemplates(),
    ...unsupportedCommands('grok', [
      U.compact(() =>
        t('Grok 的压缩只在交互界面里提供，非交互模式没有对应命令。可以用 /clear 开新标签。'),
      ),
      U.memory('AGENTS.md'),
      U.permissions(),
      U.login('grok login'),
      U.theme(),
      U.ide(),
      U.mention(),
      U.resume(),
    ]),
    ...discoveredCommands(input.discovered, 'expand'),
  ];
}
