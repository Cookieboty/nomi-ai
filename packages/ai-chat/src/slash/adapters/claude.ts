/**
 * Claude Code：文档化的非交互命令原样透传（/compact /init /code-review /security-review /effort /config），
 * 项目 / 用户自定义命令与 skills 也以 `/name args` 交给 CLI 展开；其余交互式命令明确提示。
 */
import { t } from '@nomi-ai/ui';

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
    ...(hint ? { hint } : {}),
    run: (a) => ({ type: 'send', text: a ? `/${name} ${a}` : `/${name}` }),
  });

export function claudeAdapter(input: AdapterInput): SlashCommand[] {
  return [
    ...nativeCommands('claude'),
    pass(
      'compact',
      t('压缩上下文'),
      t('让 Claude Code 压缩当前会话（官方命令，原样发送）'),
      t('[保留重点]'),
    ),
    pass('init', t('生成 CLAUDE.md'), t('让 Claude Code 初始化项目说明（官方命令，原样发送）')),
    pass('code-review', t('代码审查'), t('Claude Code 官方代码审查（原样发送）'), t('[关注点]'), [
      'review',
    ]),
    pass('security-review', t('安全审查'), t('审查当前更改里的安全问题（官方命令，原样发送）')),
    pass('effort', t('推理强度'), t('设置思考强度（官方命令，可带参数）'), t('[low|medium|high]')),
    pass(
      'config',
      t('修改配置'),
      t('用 key=value 修改 Claude Code 配置（官方命令）'),
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
