/**
 * Claude Code：文档化的非交互命令原样透传（/compact /init /code-review /security-review /effort /config），
 * 项目 / 用户自定义命令与 skills 也以 `/name args` 交给 CLI 展开；其余交互式命令明确提示。
 */
import { t } from '@nomi-ai/ui';

import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import type { AdapterInput, SlashCommand } from '../types';

import { cmd, discoveredCommands, nativeCommands, unsupportedCommands, U } from './common';

const pass = (
  name: string,
  label: string,
  description: string,
  hint?: string,
  aliases?: string[],
) =>
  cmd({
    name,
    ...(aliases ? { aliases } : {}),
    label,
    description,
    source: 'endpoint',
    kind: 'passthrough',
    badge: ENDPOINT_FULL.claude(),
    ...(hint ? { hint } : {}),
    run: (a) => ({ type: 'send', text: a ? `/${name} ${a}` : `/${name}` }),
  });

export function claudeAdapter(input: AdapterInput): SlashCommand[] {
  return [
    ...nativeCommands('claude'),
    pass(
      'compact',
      t('ui.slash-commands.compact-context'),
      t('ui.slash-commands.ask-claude-code-to-compact-the-current-session'),
      t('ui.slash-commands.focus'),
    ),
    pass(
      'init',
      t('ui.slash-commands.generate-claude-md'),
      t('ui.slash-commands.ask-claude-code-to-initialize-project-notes-official'),
    ),
    pass(
      'code-review',
      t('ui.slash-commands.code-review'),
      t('ui.slash-commands.claude-code-s-official-code-review-sent-as'),
      t('ui.slash-commands.focus-0da78a'),
      ['review'],
    ),
    pass(
      'security-review',
      t('ui.slash-commands.security-review'),
      t('ui.slash-commands.review-the-current-changes-for-security-issues-official'),
    ),
    pass(
      'effort',
      t('ui.slash-commands.effort'),
      t('ui.slash-commands.set-thinking-effort-official-command-accepts-an-argument'),
      t('[low|medium|high]'),
    ),
    pass(
      'config',
      t('ui.slash-commands.change-config'),
      t('ui.slash-commands.change-claude-code-config-with-key-value-official'),
      t('<key=value>'),
    ),
    ...unsupportedCommands('claude', [
      U.memory('CLAUDE.md'),
      U.permissions(),
      U.login('claude /login'),
      U.theme(),
      U.ide(),
      U.resume(),
    ]),
    ...discoveredCommands(input.discovered, 'passthrough'),
  ];
}
