/** dsh：没有公开的斜杠命令文档，只提供 Nomi 原生命令和两个提示词模板；目录不扫描 */
import { t } from '@nomi-ai/ui';

import type { SlashCommand } from '../types';

import { nativeCommands, promptTemplates, unsupportedCommands, U } from './common';

export function dshAdapter(): SlashCommand[] {
  return [
    ...nativeCommands('dsh'),
    ...promptTemplates(),
    ...unsupportedCommands('dsh', [
      U.compact(() => t('dsh 没有公开的压缩命令。可以用 /clear 开新标签。')),
      U.memory('AGENTS.md'),
      U.permissions(),
      U.login('dsh login'),
      U.theme(),
      U.ide(),
      U.mention(),
      U.resume(),
    ]),
  ];
}
