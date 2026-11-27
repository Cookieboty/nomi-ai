import { SDKErrorCodes, toErrorHint, type ErrorAction } from '@nomi-ai/ai-sdk-client';
import { t, Icon } from '@nomi-ai/ui';
import { Button, IconButton } from '@nomi-ai/ui';
import { IconAlertTriangle as TriangleAlert, IconX as X } from '@tabler/icons-react';
import React from 'react';

import styles from './index.module.css';

interface ErrorHintProps {
  error: unknown;
  onAction?: (action: ErrorAction['kind']) => void;
  onDismiss?: () => void;
}

export const ErrorHint: React.FC<ErrorHintProps> = ({ error, onAction, onDismiss }) => {
  if (error === null || error === undefined || error === '') return null;
  const hint = toErrorHint(error instanceof Error ? error : new Error(String(error)));
  const titleText =
    hint.code === SDKErrorCodes.E_REQUEST_TOO_LARGE
      ? t('ui.chat-settings.managed-error-request-too-large-title')
      : t(hint.title);

  const handleAction = () => {
    if (!hint.action) return;
    if (hint.action.kind === 'dismiss') {
      onDismiss?.();
      return;
    }
    onAction?.(hint.action.kind);
  };

  return (
    <div className={styles.errorHint} role="alert" data-code={hint.code}>
      <div className={styles.errorHintHeader}>
        <span className={styles.errorHintIcon} aria-hidden>
          <Icon icon={TriangleAlert} size={18} />
        </span>
        <strong className={styles.errorHintTitle}>{titleText}</strong>
        {onDismiss && (
          <IconButton
            size="sm"
            className={styles.errorHintDismiss}
            label={t('ui.foundation.dismiss-error')}
            icon={<Icon icon={X} />}
            onClick={onDismiss}
          />
        )}
      </div>
      <p className={styles.errorHintDesc}>{t(hint.description)}</p>
      {hint.action && (
        <div className={styles.errorHintActions}>
          <Button size="sm" variant="primary" onClick={handleAction}>
            {t(hint.action.label)}
          </Button>
        </div>
      )}
    </div>
  );
};
