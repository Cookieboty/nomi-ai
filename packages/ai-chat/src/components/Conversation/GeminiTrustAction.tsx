/**
 * 「Gemini 不信任此文件夹」错误卡片上的「信任此文件夹」：先说明信任意味着什么并让用户确认，
 * 确认后只把这一个文件夹写进 Gemini 自己的受信任列表（主进程按消息查出文件夹），成功后自动重试这一轮。
 */
import { Icon, t } from '@nomi-ai/ui';
import { ShieldCheck } from 'lucide-react';
import React, { useState } from 'react';

import { harnessClient } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';

/** 确认框文字：信任的范围、后果、写到哪里；范围很大的文件夹（主目录、文稿等）额外提醒 */
export function geminiTrustConfirmText(folder: string, broad: boolean): string {
  const parts = [
    t('ui.usage-tools.let-gemini-trust-this-folder'),
    folder,
    t('ui.usage-tools.once-trusted-gemini-will-load-project-configuration-from'),
    t('ui.usage-tools.this-is-saved-to-gemini-s-own-trusted'),
  ];
  if (broad) parts.push(t('ui.usage-tools.note-this-is-a-very-broad-folder-such'));
  return parts.join('\n\n');
}

type State = { kind: 'idle' | 'busy' | 'done' } | { kind: 'error'; message: string };

export const GeminiTrustAction: React.FC<{
  tabId: string;
  message: ConvMessage;
  retry?: () => void;
  /** 测试注入；默认应用内确认框 */
  confirm?: (text: string) => boolean | Promise<boolean>;
}> = ({ tabId, message, retry, confirm }) => {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const trust = message.geminiTrust;
  if (!trust) return null;
  const onClick = async () => {
    const ask = confirm ?? ((text: string) => confirmDialog({ message: text }));
    if (!(await ask(geminiTrustConfirmText(trust.folder, !!trust.broad)))) return;
    setState({ kind: 'busy' });
    try {
      await harnessClient.trustGeminiFolder(tabId, message.id);
      setState({ kind: 'done' });
      retry?.();
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };
  if (state.kind === 'done')
    return (
      <span className={styles.errorNote} role="status" data-testid="gemini-trust-done">
        {retry
          ? t('ui.usage-tools.folder-trusted-retrying')
          : t('ui.usage-tools.folder-trusted-you-can-send-your-message-again')}
      </span>
    );
  return (
    <>
      <button
        type="button"
        className={`${styles.errorBtn} ${styles.primaryBtn}`}
        onClick={() => void onClick()}
        disabled={state.kind === 'busy'}
        title={trust.folder}
        data-testid="gemini-trust-folder"
      >
        <Icon icon={ShieldCheck} size={13} />
        {t('ui.usage-tools.trust-this-folder')}
      </button>
      {state.kind === 'error' && (
        <span className={styles.errorNote} role="alert" data-testid="gemini-trust-error">
          {state.message}
        </span>
      )}
    </>
  );
};
