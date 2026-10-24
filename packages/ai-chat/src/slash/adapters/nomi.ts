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
  const title = t('交给编程助手');
  if (!delegateClient.available())
    return card(title, t('委派编程助手需要在桌面应用中使用'), 'warn');
  const s = await delegateClient.settings().catch(() => null);
  if (!s) return card(title, t('读取委派设置失败'), 'warn');
  if (!s.enabled)
    return card(
      title,
      t('「允许 Nomi 委派编程助手」已关闭，可在设置 →「编程助手」→「委派」里打开。'),
      'warn',
    );
  const list = s.installed.map(nameOf).join(' / ') || t('（没有已安装的编程助手）');
  const [first = '', ...rest] = raw.trim().split(/\s+/);
  if (!first)
    return card(
      title,
      t('用法：/agent codex 需求，或 /agent codex 后再输入需求；/agent off 取消。'),
      'info',
      t('可用：{0}', list),
    );
  if (first.toLowerCase() === 'off') {
    setNextDelegate(null);
    return card(title, t('已取消指定，Nomi 会按设置选编程助手。'));
  }
  const cli = resolveDelegateCli(first);
  if (!cli) return card(title, t('不认识「{0}」。', first), 'warn', t('可用：{0}', list));
  if (!s.installed.includes(cli))
    return card(title, t('{0} 没有安装，可在设置 →「编程助手」里安装。', nameOf(cli)), 'warn');
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
      badge: t('Nomi 技能'),
      hint: t('[说明]'),
      run: async (a, ctx) => {
        const body = await ctx.actions.nomiSkillBody(s.name);
        if (!body) return { type: 'send', text: a };
        return {
          type: 'send',
          text:
            t('请按下面的技能说明完成任务。') +
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
      label: t('交给编程助手'),
      description: t('指定下一个需求交给哪个编程助手（后台执行，如 /agent codex 修复登录 bug）'),
      source: 'builtin',
      kind: 'native',
      hint: t('名字 [需求]'),
      run: (a) => runAgent(a),
    }),
    ...unsupportedCommands('nomi', [
      U.compact(() => t('Nomi 对话暂时没有「压缩上下文」功能。可以用 /clear 开新对话。')),
    ]),
    ...skills,
  ];
}
