/** Nomi 原生对话：内置命令 + Nomi 自带 Skills（启用的 SKILL.md，展开后发给模型） */
import { t } from '@nomi-ai/ui';

import type { AdapterInput, SlashCommand } from '../types';

import { cmd, nativeCommands, unsupportedCommands, U } from './common';

export function nomiAdapter(input: AdapterInput): SlashCommand[] {
  const skills = (input.nomiSkills ?? []).map((s) =>
    cmd({
      name: s.name,
      label: `/${s.name}`,
      description: s.description,
      source: 'skill',
      kind: 'expand',
      scope: 'user',
      badge: t('Nomi 技能'),
      hint: t('[说明]'),
      run: async (a, ctx) => {
        const body = await ctx.actions.nomiSkillBody(s.name);
        if (!body) return { type: 'send', text: a };
        return {
          type: 'send',
          text: `${t('请按下面的技能说明完成任务。')}\n\n---\n${body.trim()}\n---\n${a ? `\n${a}` : ''}`,
        };
      },
    }),
  );
  return [
    ...nativeCommands('nomi'),
    ...unsupportedCommands('nomi', [
      U.compact(() => t('Nomi 对话暂时没有「压缩上下文」功能。可以用 /clear 开新对话。')),
    ]),
    ...skills,
  ];
}
