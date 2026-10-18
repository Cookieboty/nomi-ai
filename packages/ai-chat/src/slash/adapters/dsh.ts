/** dsh：没有公开的斜杠命令文档，只提供 Nomi 原生命令；CLI 自带命令不拿提示词冒充；目录不扫描 */
import { t } from '@nomi-ai/ui';

import type { SlashCommand } from '../types';

import { nativeCommands, unsupportedCommands, U } from './common';

export function dshAdapter(): SlashCommand[] {
  return [
    ...nativeCommands('dsh'),
    ...unsupportedCommands('dsh', [
      U.compact(() => t('dsh 没有公开的压缩命令。可以用 /clear 开新标签。')),
      U.review(),
      U.init('AGENTS.md'),
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
