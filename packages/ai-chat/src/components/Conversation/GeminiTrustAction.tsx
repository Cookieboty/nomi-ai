/**
 * 「Gemini 不信任此文件夹」错误卡片上的「信任此文件夹」：先说明信任意味着什么并让用户确认，
 * 确认后只把这一个文件夹写进 Gemini 自己的受信任列表（主进程按消息查出文件夹），成功后自动重试这一轮。
 */
import { Icon, t } from '@nomi-ai/ui';
import { ShieldCheck } from 'lucide-react';
import React, { useState } from 'react';

import { harnessClient } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';

import styles from './index.module.css';

/** 确认框文字：信任的范围、后果、写到哪里；范围很大的文件夹（主目录、文稿等）额外提醒 */
export function geminiTrustConfirmText(folder: string, broad: boolean): string {
  const parts = [
    t('让 Gemini 信任这个文件夹？'),
    folder,
    t(
      '信任后，Gemini 会加载这个文件夹及其所有子文件夹里的项目配置（如 .gemini/settings.json、自定义命令、MCP 服务器和钩子），这些配置可以在你的电脑上运行程序。只信任你清楚其内容的文件夹。',
    ),
    t(
      '这会写入 Gemini 自己的受信任文件夹列表，之后在终端里使用 Gemini 也同样生效；不会信任其它文件夹。',
    ),
  ];
  if (broad)
    parts.push(
      t(
        '注意：这是一个范围很大的文件夹（例如主目录或「文稿」），信任它等于信任里面的所有项目。更稳妥的做法是给这个对话换成具体的项目文件夹。',
      ),
    );
  return parts.join('\n\n');
}

type State = { kind: 'idle' | 'busy' | 'done' } | { kind: 'error'; message: string };

export const GeminiTrustAction: React.FC<{
  tabId: string;
  message: ConvMessage;
  retry?: () => void;
  /** 测试注入；默认 window.confirm */
  confirm?: (text: string) => boolean;
}> = ({ tabId, message, retry, confirm }) => {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const trust = message.geminiTrust;
  if (!trust) return null;
  const onClick = async () => {
    const ask = confirm ?? ((text: string) => window.confirm(text));
    if (!ask(geminiTrustConfirmText(trust.folder, !!trust.broad))) return;
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
        {retry ? t('已信任此文件夹，正在重试…') : t('已信任此文件夹，可以重新发送。')}
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
        {t('信任此文件夹')}
      </button>
      {state.kind === 'error' && (
        <span className={styles.errorNote} role="alert" data-testid="gemini-trust-error">
          {state.message}
        </span>
      )}
    </>
  );
};
