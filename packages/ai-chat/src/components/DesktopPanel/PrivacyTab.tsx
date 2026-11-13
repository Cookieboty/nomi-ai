/**
 * 桌面能力 →「隐私保护」：编程助手的系统沙箱（开关与「始终允许」的授权）、受保护的文件夹（Nomi 的文件工具与
 * 编程助手都不能用，叠加在内置黑名单之上）与放行给编程助手的环境变量（其余令牌 / 密码 / 云凭据类变量不继承）。
 * 规则都在 Go 内核里执行，这里只编辑清单。
 */
import { t as tr, Icon } from '@nomi-ai/ui';
import { Badge, Button, EmptyState, Input, SettingRow, SettingsGroup, Switch } from '@nomi-ai/ui';
import { Plus, ShieldCheck } from 'lucide-react';
import React, { useState } from 'react';

import { desktopClient, type DesktopState } from '../../services/desktopClient';
import { isImeComposing } from '../../utils/keyboard';
import { confirmDialog } from '../ConfirmDialog';
import { sandboxItemLabel } from '../Conversation/SandboxRequests';

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
  const sandboxOn = state.cliSandbox !== false;
  const sandboxAllow = state.cliSandboxAllow ?? [];

  // 关掉沙箱 = 放宽：先确认；打开不用
  const setSandbox = async (next: boolean) => {
    if (
      !next &&
      !(await confirmDialog({
        title: tr('ui.foundation.cli-sandbox-off-title'),
        message: tr('ui.foundation.cli-sandbox-off-body'),
        confirmLabel: tr('ui.foundation.cli-sandbox-turn-off'),
        danger: true,
      }))
    )
      return;
    await desktopClient.setCliSandbox(next);
  };

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
      <SettingsGroup title={tr('ui.foundation.cli-sandbox')}>
        <SettingRow
          title={tr('ui.foundation.cli-sandbox')}
          description={
            state.cliSandboxSupported === false
              ? tr('ui.foundation.cli-sandbox-unsupported')
              : tr('ui.foundation.cli-sandbox-desc')
          }
        >
          {state.cliSandboxSupported === false ? (
            <Badge>{tr('ui.slash-commands.unavailable')}</Badge>
          ) : (
            <Switch
              checked={sandboxOn}
              onChange={(v) => void setSandbox(v)}
              aria-label={tr('ui.foundation.cli-sandbox')}
              data-testid="desktop-cli-sandbox"
            />
          )}
        </SettingRow>
        {sandboxAllow.length > 0 && (
          <p className={styles.hint}>{tr('ui.foundation.sandbox-always-allowed')}</p>
        )}
        {sandboxAllow.map((a) => (
          <SettingRow
            key={`${a.kind}:${a.value}:${a.project ?? ''}`}
            data-testid="desktop-sandbox-allow"
            title={
              a.kind === 'category' ? (
                sandboxItemLabel(a.kind, a.value)
              ) : (
                <span className={styles.path}>{a.value}</span>
              )
            }
            description={
              (a.kind === 'category' || a.kind === 'read'
                ? tr('ui.foundation.sandbox-allow-category')
                : tr('ui.foundation.sandbox-allow-write')) +
              (a.project ? ` · ${tr('ui.foundation.sandbox-allow-project', a.project)}` : '')
            }
          >
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void desktopClient.removeCliSandboxAllow(a)}
              aria-label={tr(
                'ui.foundation.sandbox-allow-remove-aria',
                sandboxItemLabel(a.kind, a.value),
              )}
              data-testid="desktop-sandbox-allow-remove"
            >
              {tr('ui.foundation.sandbox-allow-remove')}
            </Button>
          </SettingRow>
        ))}
      </SettingsGroup>
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
            onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e.nativeEvent) && void addEnv()}
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
