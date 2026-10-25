/** Gemini（ACP）：只提供 Nomi 原生命令；CLI 自带命令在 ACP 下不经斜杠转发，不拿提示词冒充；目录不扫描 */
import { t } from '@nomi-ai/ui';

import type { SlashCommand } from '../types';

import { nativeCommands, unsupportedCommands, U } from './common';

export function geminiAdapter(): SlashCommand[] {
  return [
    ...nativeCommands('gemini'),
    ...unsupportedCommands('gemini', [
      U.compact(() => t('ui.slash-commands.gemini-doesn-t-support-compaction-in-nomi-yet')),
      U.review(),
      U.init('GEMINI.md'),
      U.memory('GEMINI.md'),
      U.permissions(),
      U.login('gemini'),
      U.theme(),
      U.ide(),
      U.mention(),
      U.resume(),
    ]),
  ];
}
