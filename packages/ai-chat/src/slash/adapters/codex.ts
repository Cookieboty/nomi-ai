/**
 * Codex CLI（`codex exec --json`）：没有文档化的非交互斜杠命令。
 * 压缩 / 审查 / 初始化是 Codex 自己的命令，这里不做成 Nomi 提示词；项目 / 用户 skills 仍由主进程展开后发送。
 */
import { t } from '@nomi-ai/ui';

import type { AdapterInput, SlashCommand } from '../types';

import { discoveredCommands, nativeCommands, unsupportedCommands, U } from './common';

export function codexAdapter(input: AdapterInput): SlashCommand[] {
  return [
    ...nativeCommands('codex'),
    ...unsupportedCommands('codex', [
      U.compact(() => t('ui.slash-commands.codex-only-offers-compaction-in-its-interactive-ui')),
      U.review(),
      U.init('AGENTS.md'),
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
