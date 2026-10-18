/**
 * Codex CLI（`codex exec --json`）：没有文档化的非交互斜杠命令。
 * /review /init 用 Nomi 提示词模板；项目 / 用户 skills 由主进程按 id 展开后发送。
 */
import { t } from '@nomi-ai/ui';

import type { AdapterInput, SlashCommand } from '../types';

import {
  discoveredCommands,
  nativeCommands,
  promptTemplates,
  unsupportedCommands,
  U,
} from './common';

export function codexAdapter(input: AdapterInput): SlashCommand[] {
  return [
    ...nativeCommands('codex'),
    ...promptTemplates(),
    ...unsupportedCommands('codex', [
      U.compact(() =>
        t('Codex 的压缩只在交互界面里提供，非交互模式没有对应命令。可以用 /clear 开新标签。'),
      ),
      U.memory('AGENTS.md'),
      U.permissions(),
      U.login('codex login'),
      U.theme(),
      U.ide(),
      U.mention(),
      U.resume(),
    ]),
    ...discoveredCommands(input.discovered, 'expand'),
  ];
}
