import { t } from '@nomi-ai/ui';
import React from 'react';

import styles from './index.module.css';

export type RuntimeChoiceView = {
  id: string;
  available: boolean;
  status:
    'ready' | 'missing-executable' | 'no-project' | 'unsupported-platform' | 'requires-provider';
  detail: string;
  login: 'unverified' | 'not-advertised' | 'not-applicable';
  requiresProject: boolean;
  degraded: string[];
};

export type ManagedRuntimeView = {
  supported: boolean;
  managed: boolean;
  backend: string;
  phase: string;
  recovery: string;
  generation: number;
  detail: string;
  choices: RuntimeChoiceView[];
  busy: boolean;
  error?: string;
};

const guidanceKey: Record<RuntimeChoiceView['status'], string> = {
  ready: 'ui.chat-settings.managed-login-unverified',
  'missing-executable': 'ui.chat-settings.managed-missing-executable',
  'no-project': 'ui.chat-settings.managed-no-project',
  'unsupported-platform': 'ui.chat-settings.managed-unsupported-platform',
  'requires-provider': 'ui.chat-settings.managed-requires-provider',
};

export const ManagedRuntimePanel: React.FC<{
  view: ManagedRuntimeView;
  onAdopt: (backend: string) => void;
  onSelect: (backend: string) => void;
  onResolve: () => void;
}> = ({ view, onAdopt, onSelect, onResolve }) => {
  const primary = view.choices[0];
  const unknown = view.managed && view.phase === 'uncertain' && view.recovery === 'unknown';
  const idle =
    !view.busy &&
    (!view.managed ||
      view.phase === 'idle' ||
      view.phase === 'completed' ||
      view.phase === 'canceled' ||
      view.phase === 'failed-pre-submit');
  const guidance = unknown
    ? t('ui.chat-settings.managed-recovery-unknown')
    : t(guidanceKey[primary?.status ?? 'missing-executable']);
  const runtimeLabel = (id: string) =>
    t(
      (
        {
          claude: 'ui.chat-settings.managed-use-claude',
          api: 'ui.chat-settings.managed-use-api',
        } as const
      )[id] ?? 'ui.chat-settings.managed-use-claude',
    );
  return (
    <section
      className={styles.dock}
      data-testid="managed-runtime-dock"
      aria-label={t('ui.chat-settings.managed-runtime-title')}
    >
      <p className={styles.title}>{t('ui.chat-settings.managed-runtime-title')}</p>
      {!view.managed && (
        <p className={styles.guidance}>{t('ui.chat-settings.managed-first-use')}</p>
      )}
      {view.managed && (
        <p className={styles.current} data-testid="managed-runtime-current">
          {t('ui.chat-settings.managed-current', view.backend || '—')}
        </p>
      )}
      <p className={styles.guidance} data-testid="managed-runtime-guidance">
        {guidance}
      </p>
      {!idle && !unknown && (
        <p className={styles.guidance}>{t('ui.chat-settings.managed-idle-only')}</p>
      )}
      {view.error && (
        <p className={styles.error} data-testid="managed-runtime-error">
          {view.error}
        </p>
      )}
      <div className={styles.actions}>
        {unknown && (
          <button type="button" data-testid="managed-runtime-new-native" onClick={onResolve}>
            {t('ui.chat-settings.managed-new-native')}
          </button>
        )}
        {!view.managed &&
          view.choices.map((choice) => (
            <button
              key={`adopt-${choice.id}`}
              type="button"
              data-testid={`managed-runtime-adopt-${choice.id}`}
              disabled={!choice.available || !view.supported}
              onClick={() => onAdopt(choice.id)}
            >
              {runtimeLabel(choice.id)}
            </button>
          ))}
        {view.managed &&
          view.choices
            .filter((choice) => choice.id !== view.backend)
            .map((choice) => (
              <button
                key={`select-${choice.id}`}
                type="button"
                data-testid={`managed-runtime-select-${choice.id}`}
                disabled={!idle || !choice.available}
                onClick={() => onSelect(choice.id)}
              >
                {runtimeLabel(choice.id)}
              </button>
            ))}
      </div>
    </section>
  );
};
