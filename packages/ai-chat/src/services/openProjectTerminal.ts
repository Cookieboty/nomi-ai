/**
 * 快捷键「在终端打开当前项目」：在当前会话的项目目录（编程助手标签的目录，或 Nomi 对话选的工作区）打开终端。
 * 内核按工作目录规则再校验目录；没有目录、目录不认、找不到终端时用 notify 告诉用户。
 */
import { isContractError } from '@nomi-ai/contract';
import { t } from '@nomi-ai/ui';

import { harnessClient } from './harnessClient';

export function openProjectTerminal(cwd: string | null, notify: (msg: string) => void): void {
  if (!cwd) {
    notify(t('ui.chat-settings.open-terminal-no-project'));
    return;
  }
  void harnessClient.openTerminal(cwd).catch((e: unknown) => {
    notify(
      isContractError(e, 'TERMINAL_NOT_FOUND')
        ? t('ui.chat-settings.open-terminal-not-found')
        : isContractError(e, 'TERMINAL_CWD_DENIED')
          ? t('ui.chat-settings.open-terminal-denied', e.message)
          : e instanceof Error
            ? e.message
            : String(e),
    );
  });
}
