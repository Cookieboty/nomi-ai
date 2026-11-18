import { BUILTIN_MANIFESTS } from '@nomi-ai/cli-catalog';
import { Badge, Button, Disclosure, Input, Notice, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useId, useState } from 'react';

import {
  cliLauncherClient,
  useCliLauncher,
  useHasLocalLogin,
} from '../../services/cliLauncherClient';
import type { CliKind } from '../../services/cliSource';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import styles from './index.module.css';

export const CliLauncherCard: React.FC<{ kind: CliKind }> = ({ kind }) => {
  const saved = useCliLauncher(kind);
  const hasLocal = useHasLocalLogin(kind);
  const [lastSaved, setLastSaved] = useState(saved);
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState('');
  const [didSave, setDidSave] = useState(false);
  const id = useId();
  if (saved !== lastSaved) {
    setLastSaved(saved);
    setDraft(saved);
  }
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const automaticCommand = BUILTIN_MANIFESTS[kind].binary.names[0] ?? kind;
  const edit = (patch: Partial<typeof draft>) => {
    setDraft((old) => ({ ...old, ...patch }));
    setVersion('');
    setError('');
    setDidSave(false);
  };
  const run = async (action: 'save' | 'test') => {
    setBusy(action);
    setError('');
    setDidSave(false);
    try {
      if (action === 'save') {
        await cliLauncherClient.save(kind, draft);
        setDidSave(true);
      } else
        setVersion(
          (await cliLauncherClient.test(kind, draft.enabled ? draft.command : '')).version,
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsGroup
      title={t('ui.chat-settings.cli-launcher-local')}
      actions={
        <Badge tone={hasLocal ? 'success' : 'neutral'} data-testid={`cli-local-status-${kind}`}>
          {t(hasLocal ? 'ui.models.local-sign-in-detected' : 'ui.models.local-sign-in-undetected')}
        </Badge>
      }
      data-testid="cli-launcher-card"
    >
      <div className={styles.launcherBody}>
        <p className={styles.sub}>{t('ui.chat-settings.cli-launcher-local-coexist-hint')}</p>
        <p className={styles.sub}>
          {draft.enabled
            ? t('ui.chat-settings.cli-launcher-custom-active', draft.command || automaticCommand)
            : t('ui.chat-settings.cli-launcher-auto-hint', ENDPOINT_NAME[kind])}
        </p>
        <Disclosure
          summary={t('ui.chat-settings.cli-launcher-advanced')}
          defaultOpen={saved.enabled}
          data-testid="cli-launcher-advanced"
        >
          <div className={styles.launcherAdvanced}>
            <Switch
              checked={draft.enabled}
              disabled={busy !== null}
              onChange={(enabled) => edit({ enabled })}
              label={t('ui.chat-settings.cli-launcher-enable')}
              data-testid="cli-launcher-enable"
            />
            {draft.enabled && (
              <>
                <label htmlFor={id} className={styles.launcherLabel}>
                  {t('ui.chat-settings.cli-launcher-command')}
                </label>
                <Input
                  id={id}
                  value={draft.command}
                  placeholder={automaticCommand}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy !== null}
                  onChange={(e) => edit({ command: e.target.value })}
                  aria-describedby={`${id}-hint`}
                  data-testid="cli-launcher-command"
                />
                <p id={`${id}-hint`} className={styles.sub}>
                  {t('ui.chat-settings.cli-launcher-command-hint', automaticCommand)}
                </p>
              </>
            )}
            <p className={styles.sub}>{t('ui.chat-settings.cli-launcher-network-hint')}</p>
          </div>
        </Disclosure>
        <div className={styles.launcherActions}>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null || (draft.enabled && !draft.command.trim())}
            onClick={() => void run('test')}
            data-testid="cli-launcher-test"
          >
            {t(busy === 'test' ? 'ui.foundation.testing' : 'ui.chat-settings.cli-launcher-test')}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null || !dirty || (draft.enabled && !draft.command.trim())}
            onClick={() => void run('save')}
            data-testid="cli-launcher-save"
          >
            {t(busy === 'save' ? 'ui.voice-mascot.saving' : 'ui.foundation.save')}
          </Button>
          {didSave && (
            <span role="status" className={styles.sub}>
              {t('ui.chat-settings.cli-launcher-saved')}
            </span>
          )}
        </div>
        {version && (
          <Notice tone="success" data-testid="cli-launcher-result">
            {t('ui.chat-settings.cli-launcher-test-success', version)}
          </Notice>
        )}
        {error && (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        )}
      </div>
    </SettingsGroup>
  );
};
