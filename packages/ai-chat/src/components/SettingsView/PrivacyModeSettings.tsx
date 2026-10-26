/**
 * 设置 → 隐私与权限 →「隐私模式」（docs/design/secret-privacy.md §12）：
 * 发往云端第三方供应商前把密钥换成占位符，默认开；关闭前要确认，重新打开不需要。
 * 状态来自网关（ai:gateway:state 的 privacyMode），旧主进程没有这个字段时不显示。
 */
import { SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useState } from 'react';

import { gatewayClient } from '../../services/gatewayClient';
import { useGatewayState } from '../../services/nomiModel';

export const PrivacyModeSettings: React.FC = () => {
  const state = useGatewayState();
  const [busy, setBusy] = useState(false);
  if (typeof state?.privacyMode !== 'boolean') return null;
  const on = state.privacyMode;

  const set = (next: boolean) => {
    if (
      !next &&
      !window.confirm(t('ui.chat-settings.turn-off-privacy-mode-keys-will-be-sent-as-is'))
    )
      return;
    setBusy(true);
    // 改完主进程会广播 ai:gateway:changed，useGatewayState 随之刷新
    void gatewayClient
      .setOptions({ privacyMode: next })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <SettingsGroup title={t('ui.chat-settings.privacy-mode')} data-testid="settings-privacy-mode">
      <SettingRow
        title={t('ui.chat-settings.hide-keys-before-sending-to-third-party-providers')}
        description={
          on
            ? t('ui.chat-settings.keys-in-chats-files-and-command-output-become-placeholders')
            : t('ui.chat-settings.privacy-mode-is-off-keys-are-sent-as-is')
        }
      >
        <Switch
          checked={on}
          disabled={busy}
          onChange={set}
          aria-label={t('ui.chat-settings.hide-keys-before-sending-to-third-party-providers')}
          data-testid="privacy-mode-switch"
        />
      </SettingRow>
    </SettingsGroup>
  );
};
