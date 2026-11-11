/**
 * 派出编程助手：目录里排在前面的两个（Claude Code、Codex）。
 * 一个主按钮，旁边是另一个助手。名字来自清单，不在这里写死 id 名单。
 */
import { BUILTIN_CLI_ORDER, cliName, type BuiltinCliId } from '@nomi-ai/cli-catalog';
import { Button, t } from '@nomi-ai/ui';
import React from 'react';

import styles from './index.module.css';

/** 看板空态和欢迎屏共用的两个助手 */
export const DISPATCH_CLIS: readonly BuiltinCliId[] = BUILTIN_CLI_ORDER.slice(0, 2);

export type DispatchBackend = (typeof DISPATCH_CLIS)[number];

export const DispatchCli: React.FC<{
  onDispatch: (backend: DispatchBackend) => void;
}> = ({ onDispatch }) => (
  <div
    className={styles.row}
    role="group"
    aria-label={t('ui.cli-monitor.fleet-dispatch')}
    data-testid="fleet-dispatch"
  >
    {DISPATCH_CLIS.map((id, i) => (
      <Button
        key={id}
        size="sm"
        variant={i === 0 ? 'primary' : 'secondary'}
        data-testid={`dispatch-cli-${id}`}
        onClick={() => onDispatch(id)}
      >
        {t('ui.cli-monitor.fleet-dispatch-one', cliName(id))}
      </Button>
    ))}
  </div>
);
