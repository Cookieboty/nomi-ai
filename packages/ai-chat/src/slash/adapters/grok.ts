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
    pass('compact', t('压缩上下文'), t('让 Grok 压缩当前会话（Grok 自己的命令，原样发送）')),
    pass(
      'context',
      t('上下文用量'),
      t('让 Grok 查看当前会话的上下文用量（Grok 自己的命令，原样发送）'),
    ),
    pass(
      'always-approve',
      t('始终批准'),
      t('让 Grok 跳过后续的权限询问（Grok 自己的命令，原样发送）'),
    ),
    pass(
      'session-info',
      t('会话信息'),
      t('查看 Grok 当前会话的登录、模型和用量（Grok 自己的命令，原样发送）'),
    ),
    pass('feedback', t('反馈'), t('把一段说明发给 Grok 的反馈入口（Grok 自己的命令，原样发送）')),
    pass(
      'deep-research',
      t('深度研究'),
      t('让 Grok 做带来源核对的研究（Grok 自己的命令，原样发送）'),
      t('[问题]'),
    ),
    pass('workflow', t('工作流'), t('运行或查看 Grok 工作流（Grok 自己的命令，原样发送）')),
    pass(
      'goal',
      t('持续目标'),
      t('给 Grok 一个持续目标（Grok 自己的命令，原样发送）'),
      t('[目标]'),
    ),
    pass(
      'loop',
      t('循环'),
      t('让 Grok 按间隔重复一项任务（Grok 自己的命令，原样发送）'),
      t('[间隔与任务]'),
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
