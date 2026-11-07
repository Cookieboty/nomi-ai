/**
 * 桌面能力 →「隐私保护」：受保护的文件夹（Nomi 的文件工具与编程助手都不能用，叠加在内置黑名单之上）
 * 与放行给编程助手的环境变量（其余令牌 / 密码 / 云凭据类变量不继承）。规则都在 Go 内核里执行，这里只编辑清单。
 */
import { t as tr, Icon } from '@nomi-ai/ui';
import { Button, EmptyState, Input, SettingRow, SettingsGroup } from '@nomi-ai/ui';
import { Plus, ShieldCheck } from 'lucide-react';
import React, { useState } from 'react';

import { desktopClient, type DesktopState } from '../../services/desktopClient';
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Props {
  state: DesktopState;
  onMessage: (msg: string) => void;
}

export const PrivacyTab: React.FC<Props> = ({ state, onMessage }) => {
  const [envName, setEnvName] = useState('');
  const protectedPaths = state.protectedPaths ?? [];
  const envAllow = state.cliEnvAllow ?? [];

  const protect = async () => {
    try {
      const r = await desktopClient.protectFolder();
      if (!r) onMessage(tr('ui.foundation.cancelled'));
      else if (r.error) onMessage(r.error);
      else onMessage(tr('ui.foundation.protected-folder-added', r.path ?? ''));
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e));
    }
  };

  // 取消保护 = 放宽：先确认
  const unprotect = async (path: string) => {
    if (
      !(await confirmDialog({
        title: tr('ui.foundation.unprotect-folder-title'),
        message: tr('ui.foundation.unprotect-folder-body', path),
        confirmLabel: tr('ui.foundation.unprotect'),
        danger: true,
      }))
    )
      return;
    await desktopClient.unprotectPath(path);
  };

  const addEnv = async () => {
    const name = envName.trim();
    if (!ENV_NAME.test(name)) {
      onMessage(tr('ui.foundation.env-name-invalid'));
      return;
    }
    if (envAllow.some((n) => n.toUpperCase() === name.toUpperCase())) {
      setEnvName('');
      return;
    }
    if (
      !(await confirmDialog({
        title: tr('ui.foundation.allow-env-title'),
        message: tr('ui.foundation.allow-env-body', name),
        confirmLabel: tr('ui.chat-settings.allow'),
        danger: true,
      }))
    )
      return;
    await desktopClient.setCliEnvAllow([...envAllow, name]);
    setEnvName('');
  };

  const removeEnv = (name: string) =>
    void desktopClient.setCliEnvAllow(envAllow.filter((n) => n !== name));

  return (
    <div className={styles.stack} data-testid="desktop-privacy">
      <SettingsGroup
        title={tr('ui.foundation.protected-folders')}
        description={tr('ui.foundation.protected-folders-desc')}
        actions={
          <Button
            size="sm"
            variant="primary"
            onClick={() => void protect()}
            data-testid="desktop-protect"
          >
            <Icon icon={Plus} size={14} />
            {tr('ui.foundation.add-protected-folder')}
          </Button>
        }
      >
        <p className={styles.hint}>{tr('ui.foundation.protected-builtin-hint')}</p>
        {protectedPaths.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={tr('ui.foundation.no-protected-folders')}
            description={tr('ui.foundation.no-protected-folders-desc')}
          />
        ) : (
          protectedPaths.map((p) => (
            <SettingRow
              key={p}
              data-testid="desktop-protected-path"
              title={<span className={styles.path}>{p}</span>}
            >
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void unprotect(p)}
                aria-label={tr('ui.foundation.unprotect-folder-aria', p)}
                data-testid="desktop-unprotect"
              >
                {tr('ui.foundation.unprotect')}
              </Button>
            </SettingRow>
          ))
        )}
      </SettingsGroup>

      <SettingsGroup
        title={tr('ui.foundation.cli-env-allow')}
        description={tr('ui.foundation.cli-env-allow-desc')}
      >
        {envAllow.map((name) => (
          <SettingRow
            key={name}
            data-testid="desktop-env-allow"
            title={<code className={styles.code}>{name}</code>}
          >
            <Button
              size="sm"
              variant="ghost"
              onClick={() => removeEnv(name)}
              aria-label={tr('ui.foundation.remove-env-allow', name)}
              data-testid="desktop-env-allow-remove"
            >
              {tr('ui.knowledge-local.remove')}
            </Button>
          </SettingRow>
        ))}
        <div className={styles.inlineForm}>
          <Input
            size="sm"
            value={envName}
            placeholder={tr('ui.foundation.env-name-placeholder')}
            aria-label={tr('ui.foundation.env-name-placeholder')}
            onChange={(e) => setEnvName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addEnv()}
            data-testid="desktop-env-allow-input"
          />
          <Button
            size="sm"
            onClick={() => void addEnv()}
            disabled={!envName.trim()}
            data-testid="desktop-env-allow-add"
          >
            {tr('ui.chat-settings.allow')}
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
};
