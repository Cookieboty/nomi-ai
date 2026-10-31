/**
 * Codex CLI（app-server 常驻模式；退路 `codex exec --json`）：没有文档化的非交互斜杠命令。
 * /compact 原样发给主进程，由主进程改发 app-server 的 thread/compact/start（exec 退路没有压缩，会提示）。
 * 审查 / 初始化是 Codex 自己的命令，这里不做成 Nomi 提示词；项目 / 用户 skills 仍由主进程展开后发送。
 */
import { t } from '@nomi-ai/ui';

import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import type { AdapterInput, SlashCommand } from '../types';

import { cmd, discoveredCommands, nativeCommands, unsupportedCommands, U } from './common';

export function codexAdapter(input: AdapterInput): SlashCommand[] {
  return [
    ...nativeCommands('codex'),
    cmd({
      name: 'compact',
      label: t('ui.slash-commands.compact-context'),
      description: t('ui.slash-commands.ask-codex-to-compact-the-current-session'),
      source: 'endpoint',
      kind: 'passthrough',
      badge: ENDPOINT_FULL.codex(),
      run: () => ({ type: 'send', text: '/compact' }),
    }),
    ...unsupportedCommands('codex', [
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
