/**
 * Grok（`grok -p`）：无头模式会执行 shell 内置命令和 user-invocable skills。
 * 这些原样发给 Grok，不做成 Nomi 卡片或提示词。分页器才有的命令仍然拦下。
 */
import { t } from '@nomi-ai/ui';

import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import type { AdapterInput, SlashCommand } from '../types';

import { cmd, discoveredCommands, nativeCommands, unsupportedCommands, U } from './common';

const pass = (name: string, label: string, description: string, hint?: string) =>
  cmd({
    name,
    label,
    description,
    source: 'endpoint',
    kind: 'passthrough',
    badge: ENDPOINT_FULL.grok(),
    ...(hint ? { hint } : {}),
    run: (a) => ({ type: 'send', text: a ? `/${name} ${a}` : `/${name}` }),
  });

export function grokAdapter(input: AdapterInput): SlashCommand[] {
  return [
    // /context 是 Grok 自己的命令。Nomi 卡片不再占用这个名字。
    ...nativeCommands('grok').filter((c) => c.name !== 'context'),
    pass(
      'compact',
      t('ui.slash-commands.compact-context'),
      t('ui.slash-commands.ask-grok-to-compact-the-current-session-grok'),
    ),
    pass(
      'context',
      t('ui.slash-commands.context-usage'),
      t('ui.slash-commands.ask-grok-to-show-this-session-s-context'),
    ),
    pass(
      'always-approve',
      t('ui.slash-commands.always-approve'),
      t('ui.slash-commands.tell-grok-to-skip-later-permission-prompts-grok'),
    ),
    pass(
      'session-info',
      t('ui.slash-commands.session-info'),
      t('ui.slash-commands.show-grok-s-login-model-and-usage-for'),
    ),
    pass(
      'feedback',
      t('ui.slash-commands.feedback'),
      t('ui.slash-commands.send-a-note-to-grok-s-feedback-command'),
    ),
    pass(
      'deep-research',
      t('ui.slash-commands.deep-research'),
      t('ui.slash-commands.ask-grok-to-research-a-question-and-check'),
      t('ui.slash-commands.question'),
    ),
    pass(
      'workflow',
      t('ui.slash-commands.workflow'),
      t('ui.slash-commands.run-or-inspect-a-grok-workflow-grok-s'),
    ),
    pass(
      'goal',
      t('ui.slash-commands.standing-goal'),
      t('ui.slash-commands.give-grok-a-standing-goal-grok-s-own'),
      t('ui.slash-commands.goal'),
    ),
    pass(
      'loop',
      t('ui.slash-commands.loop'),
      t('ui.slash-commands.ask-grok-to-repeat-a-task-on-an'),
      t('ui.slash-commands.interval-and-task'),
    ),
    ...unsupportedCommands('grok', [
      U.init('AGENTS.md'),
      U.memory('AGENTS.md'),
      U.permissions(),
      U.login('grok login'),
      U.theme(),
      U.ide(),
      U.mention(),
      U.resume(),
    ]),
    ...discoveredCommands(input.discovered, 'passthrough'),
  ];
}
