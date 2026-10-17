/**
 * 对话后端切换：Nomi（默认）| Claude Code | Codex | dsh | Grok。
 * 有消息的会话切换后端时不改写身份：为新后端新建会话 / CLI 标签（可随后分叉复制历史）。
 * 空会话可原地切换。CLI 标签不含 Nomi。
 */
import { Select, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { useAiChat } from '../../contexts/AiChatContext';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import {
  harnessClient,
  type HarnessBackend,
  type HarnessState,
} from '../../services/harnessClient';
import { EndpointIcon } from '../EndpointIcon';

const LABELS: Record<HarnessBackend, () => string> = {
  nomi: () => t('Nomi'),
  claude: () => t('Claude Code'),
  codex: () => t('Codex'),
  dsh: () => 'dsh',
  grok: () => 'Grok',
};

export const BackendSwitcher: React.FC<{ className?: string }> = ({ className }) => {
  const [state, setState] = useState<HarnessState | null>(null);
  const available = harnessClient.available();
  const tabs = useHarnessTabs();
  const { isDev, setMode } = useChatMode();
  const { state: chat, actions } = useAiChat();

  useEffect(() => {
    if (!available) return;
    void harnessClient
      .state()
      .then(setState)
      .catch(() => setState(null));
    return harnessClient.onChanged(setState);
  }, [available]);

  if (!available || !state || !isDev) return null;

  const tab = tabs.isCliTab ? tabs.activeTab : null;
  const value: HarnessBackend = tab ? tab.backend : state.backend;
  const busy = tab ? tab.status === 'running' || tab.status === 'queued' : state.busy;
  const hasMessages = tab ? (tabs.messages?.length ?? 0) > 0 : chat.messages.length > 0;

  const switchTo = async (v: HarnessBackend) => {
    if (v === value) return;

    // CLI 标签：空会话可原地换后端；有消息则新建标签
    if (tab) {
      if (v === 'nomi') return;
      if (!hasMessages) {
        await harnessClient.setTabBackend(tab.id, v).catch(() => undefined);
        return;
      }
      await tabs.create(v);
      return;
    }

    // 主标签
    if (!hasMessages) {
      if (v === 'nomi') {
        await harnessClient
          .setBackend('nomi')
          .then(setState)
          .catch(() => undefined);
        return;
      }
      // 空主会话切到 CLI → 开新标签（主标签保持 Nomi 身份干净）
      setMode('dev');
      await tabs.create(v);
      return;
    }

    // 有消息：新建目标端会话，不改写当前历史
    if (v === 'nomi') {
      await actions.newConversation();
      await harnessClient
        .setBackend('nomi')
        .then(setState)
        .catch(() => undefined);
      return;
    }
    setMode('dev');
    await tabs.create(v);
  };

  return (
    <span
      className={className}
      data-testid="backend-switcher"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      title={
        hasMessages ? t('切换后端将新建会话，当前对话保留（可用分叉复制历史）') : t('切换对话端点')
      }
    >
      <Select
        size="sm"
        style={{ width: 'auto', minWidth: 112, maxWidth: 220 }}
        menuMinWidth={200}
        data-testid="backend-switch"
        aria-label={t('对话后端')}
        value={value}
        disabled={busy}
        onChange={(e) => {
          void switchTo(e.target.value as HarnessBackend);
        }}
        options={(Object.keys(LABELS) as HarnessBackend[])
          .filter((k) => !tab || k !== 'nomi')
          .map((k) => {
            const missing = k !== 'nomi' && !state.bins[k];
            return {
              value: k,
              label: LABELS[k](),
              icon: <EndpointIcon backend={k} size={16} decorative />,
              // 未安装的 CLI 置灰，只留一个很短的后缀
              description: missing ? t('未安装') : undefined,
              disabled: missing,
            };
          })}
      />
      {!tab && state.toolsDisabled && (
        <span
          data-testid="harness-tools-off"
          style={{ fontSize: 11, opacity: 0.75, whiteSpace: 'nowrap' }}
        >
          {t('Nomi 工具已关闭')}
        </span>
      )}
    </span>
  );
};
