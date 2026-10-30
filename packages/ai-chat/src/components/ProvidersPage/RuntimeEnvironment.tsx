/**
 * 设置 →「编程助手」顶部：安装 / 更新编程助手要用的本机 Node.js 与 npm。
 * Node 版与 Go 版都调用系统的 npm，所以在点「安装 / 更新」之前就把缺什么、版本够不够摆出来。
 */
import { BUILTIN_RENDERER } from '@nomi-ai/cli-catalog';
import { Badge, Button, Notice, SettingRow, SettingsGroup, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import { cliUpdateClient, type CliEnvironment } from '../../services/cliUpdateClient';

import styles from './index.module.css';

const NODE_DOWNLOAD_URL = 'https://nodejs.org/';

export const RuntimeEnvironment: React.FC = () => {
  const [env, setEnv] = useState<CliEnvironment | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    setChecking(true);
    try {
      setEnv(await cliUpdateClient.environment());
    } catch {
      setEnv(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!cliUpdateClient.available()) return;
    void load();
    // 装完 / 更新完再看一次（npm 装的 CLI 可能顺带换了 PATH 上的东西）
    return cliUpdateClient.onEvent((e) => {
      if (e.phase === 'done') void load();
    });
  }, [load]);

  if (!cliUpdateClient.available() || !env) return null;

  const unmet = env.requirements.filter((r) => !r.ok);
  const allOk = !!env.nodeVersion && unmet.length === 0;

  return (
    <SettingsGroup
      title={t('ui.cli-monitor.runtime-environment')}
      description={t('ui.cli-monitor.runtime-environment-description')}
      data-testid="cli-runtime-environment"
      actions={
        <Button
          size="sm"
          variant="ghost"
          disabled={checking}
          data-testid="cli-runtime-check"
          onClick={() => void load()}
        >
          {checking ? t('ui.cli-monitor.checking') : t('ui.models.detect-again')}
        </Button>
      }
    >
      <SettingRow
        title="Node.js"
        description={
          env.nodePath ? (
            <span className={styles.path} title={env.nodePath}>
              {env.nodePath}
            </span>
          ) : undefined
        }
      >
        <span className={styles.ver} data-testid="cli-runtime-node-version">
          {env.nodeVersion ? `v${env.nodeVersion}` : '—'}
        </span>
        <Badge
          tone={allOk ? 'success' : env.nodeVersion ? 'warning' : 'danger'}
          data-testid="cli-runtime-node-state"
          data-state={allOk ? 'ok' : env.nodeVersion ? 'old' : 'missing'}
        >
          {allOk
            ? t('ui.cli-monitor.node-js-meets-every-assistant')
            : env.nodeVersion
              ? t('ui.cli-monitor.node-js-too-old')
              : t('ui.mascot-theme.not-found')}
        </Badge>
      </SettingRow>
      <SettingRow
        title="npm"
        description={
          env.npmPath ? (
            <span className={styles.path} title={env.npmPath}>
              {env.npmPath}
            </span>
          ) : undefined
        }
      >
        <Badge tone={env.npmPath ? 'success' : 'danger'} data-testid="cli-runtime-npm-state">
          {env.npmPath ? t('ui.knowledge-local.installed') : t('ui.mascot-theme.not-found')}
        </Badge>
      </SettingRow>

      {!env.nodeVersion ? (
        <Notice tone="danger" data-testid="cli-runtime-notice">
          {t('ui.cli-monitor.node-js-not-found-install-it')}{' '}
          <a href={NODE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
            {t('ui.cli-monitor.download-node-js')}
          </a>
        </Notice>
      ) : unmet.length > 0 ? (
        <Notice tone="warning" data-testid="cli-runtime-notice">
          {unmet.map((r) => (
            <div key={r.kind}>
              {t(
                'ui.cli-monitor.needs-node-js-or-newer',
                BUILTIN_RENDERER[r.kind]?.displayName ?? r.kind,
                r.minNode,
              )}
            </div>
          ))}
          <a href={NODE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
            {t('ui.cli-monitor.download-node-js')}
          </a>
        </Notice>
      ) : null}
      {env.nodeVersion && !env.npmPath && (
        <Notice tone="warning" data-testid="cli-runtime-npm-notice">
          {t('ui.cli-monitor.npm-not-found-ships-with-node')}
        </Notice>
      )}
    </SettingsGroup>
  );
};
