/** Nomi 原生对话：内置命令 + Nomi 自带 Skills（启用的 SKILL.md，展开后发给模型） */
import { t } from '@nomi-ai/ui';

import {
  delegateClient,
  resolveDelegateCli,
  setNextDelegate,
  type DelegateCli,
} from '../../services/delegateClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { notice } from '../cards';
import type { AdapterInput, SlashCommand, SlashOutcome } from '../types';

import { cmd, nativeCommands, unsupportedCommands, U } from './common';

const nameOf = (c: DelegateCli) => t(ENDPOINT_NAME[c]);

/**
 * `/agent 名字 [需求]`：指定下一个需求交给哪个编程助手（docs/design/nomi-delegate-cli.md §4.6）。
 * 带需求就立即发出；只有名字时在输入框上方挂一个「下一个需求交给 X」，下一条消息发出后自动取消。
 */
async function runAgent(raw: string): Promise<SlashOutcome> {
  const card = (title: string, text: string, tone: 'info' | 'warn' = 'info', detail?: string) =>
    ({ type: 'card', card: notice(title, text, tone, detail ? { detail } : undefined) }) as const;
  const title = t('ui.slash-commands.hand-off-to-a-coding-assistant');
  if (!delegateClient.available())
    return card(
      title,
      t('ui.chat-settings.handing-off-to-coding-assistants-needs-the-desktop'),
      'warn',
    );
  const s = await delegateClient.settings().catch(() => null);
  if (!s) return card(title, t('ui.slash-commands.couldn-t-read-the-handoff-settings'), 'warn');
  if (!s.enabled)
    return card(title, t('ui.slash-commands.let-nomi-hand-off-tasks-to-coding-assistants'), 'warn');
  const list =
    s.installed.map(nameOf).join(' / ') || t('ui.slash-commands.no-coding-assistants-installed');
  const [first = '', ...rest] = raw.trim().split(/\s+/);
  if (!first)
    return card(
      title,
      t('ui.slash-commands.usage-agent-codex-request-or-agent-codex-and'),
      'info',
      t('ui.slash-commands.available', list),
    );
  if (first.toLowerCase() === 'off') {
    setNextDelegate(null);
    return card(title, t('ui.slash-commands.cleared-nomi-will-pick-a-coding-assistant-from'));
  }
  const cli = resolveDelegateCli(first);
  if (!cli)
    return card(
      title,
      t('ui.chat-settings.unknown-mode', first),
      'warn',
      t('ui.slash-commands.available', list),
    );
  if (!s.installed.includes(cli))
    return card(
      title,
      t('ui.slash-commands.isn-t-installed-you-can-install-it-in', nameOf(cli)),
      'warn',
    );
  setNextDelegate(cli);
  const task = rest.join(' ').trim();
  return task ? { type: 'send', text: task } : { type: 'noop' };
}

export function nomiAdapter(input: AdapterInput): SlashCommand[] {
  const skills = (input.nomiSkills ?? []).map((s) =>
    cmd({
      name: s.name,
      label: `/${s.name}`,
      description: s.description,
      source: 'skill',
      kind: 'expand',
      scope: 'user',
      badge: t('ui.slash-commands.nomi-skill'),
      hint: t('ui.slash-commands.notes'),
      run: async (a, ctx) => {
        const body = await ctx.actions.nomiSkillBody(s.name);
        if (!body) return { type: 'send', text: a };
        return {
          type: 'send',
          text:
            t('ui.slash-commands.please-complete-the-task-following-the-skill-instructions') +
            '\n\n---\n' +
            body.trim() +
            '\n---\n' +
            (a ? '\n' + a : ''),
        };
      },
    }),
  );
  return [
    ...nativeCommands('nomi'),
    cmd({
      name: 'agent',
      // 旧名 /cli 仍可用，但不在面板和提示里出现
      hiddenAliases: ['cli'],
      label: t('ui.slash-commands.hand-off-to-a-coding-assistant'),
      description: t('ui.slash-commands.pick-which-coding-assistant-handles-your-next-request'),
      source: 'builtin',
      kind: 'native',
      hint: t('ui.slash-commands.name-request'),
      run: (a) => runAgent(a),
    }),
    ...unsupportedCommands('nomi', [
      U.compact(() => t('ui.slash-commands.nomi-chat-has-no-compact-context-feature-yet')),
    ]),
    ...skills,
  ];
}
