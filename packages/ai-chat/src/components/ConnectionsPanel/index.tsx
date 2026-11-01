/**
 * 设置 → 连接（docs/design/connections.md §7）：Nomi 能用的外部账号。2.1.0 先接 GitHub：
 * 复用本机 gh 登录（凭据留在 gh 里，Nomi 不读令牌），或粘贴令牌（经系统加密保存）。
 * 宽权限如实提示：能做什么由任务授权决定，不由令牌决定。
 */
import { Badge, Button, Icon, Input, t } from '@nomi-ai/ui';
import { Link2, RefreshCw, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';

export interface ConnectionView {
  id: string;
  label: string;
  auth: { kind: 'cli-login' | 'keychain'; host: string };
  account?: { login: string; host: string };
  observedScopes?: string[];
  wideScopes?: string[];
  status: 'ok' | 'needs_login' | 'error' | 'disabled';
  checkedAt?: number;
}

interface GhAccount {
  host: string;
  login: string;
  scopes: string[];
  wideScopes: string[];
  active: boolean;
  state: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 连接列表：拉一次并跟着 connections.changed 刷新 */
export function useConnections(enabled = true) {
  const [items, setItems] = useState<ConnectionView[] | null>(null);
  const load = useCallback(() => {
    if (!hasTransport()) return;
    void api.connections
      .list()
      .then((l) => setItems(l as unknown as ConnectionView[]))
      .catch(() => setItems([]));
  }, []);
  useEffect(() => {
    if (!enabled || !hasTransport()) return;
    load();
    return api.on('connections.changed', load);
  }, [enabled, load]);
  return { items, reload: load };
}

export const ConnectionsPanel: React.FC = () => {
  const { items } = useConnections();
  const [gh, setGh] = useState<{ installed: boolean; accounts: GhAccount[] } | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detect = useCallback(() => {
    void api.connections
      .detect({})
      .then((r) => setGh((r as unknown as { gh: typeof gh }).gh))
      .catch((e) => setError(errText(e)));
  }, []);
  useEffect(() => {
    if (hasTransport()) detect();
  }, [detect]);

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void fn()
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false));
  };
  const active = gh?.accounts.find((a) => a.active && a.state === 'success');

  return (
    <div className={styles.panel} data-testid="connections-panel">
      <section className={styles.block} aria-label={t('ui.chat-settings.connected')}>
        <h3 className={styles.title}>{t('ui.chat-settings.connected')}</h3>
        {items && !items.length && (
          <p className={styles.muted}>{t('ui.providers-schedule.connections-empty')}</p>
        )}
        <ul className={styles.list}>
          {items?.map((c) => (
            <li key={c.id} className={styles.item} data-testid={`connection-${c.id}`}>
              <Icon icon={Link2} size={16} />
              <div className={styles.itemBody}>
                <span className={styles.itemTitle}>{c.label}</span>
                <span className={styles.muted}>
                  {c.auth.kind === 'cli-login'
                    ? t('ui.providers-schedule.connection-via-gh', c.auth.host)
                    : t('ui.providers-schedule.connection-via-token', c.auth.host)}
                </span>
                {!!c.wideScopes?.length && (
                  <span className={styles.warn}>
                    {t('ui.providers-schedule.connection-wide-scopes', c.wideScopes.join(', '))}
                  </span>
                )}
              </div>
              <Badge tone={c.status === 'ok' ? 'success' : 'warning'}>
                {c.status === 'ok'
                  ? t('ui.providers-schedule.connection-ok')
                  : t('ui.providers-schedule.sign-in-again')}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => run(() => api.connections.check({ id: c.id }))}
                aria-label={t('ui.models.detect-again')}
                data-testid={`connection-check-${c.id}`}
              >
                <Icon icon={RefreshCw} size={14} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    if (
                      await confirmDialog({
                        message: t('ui.providers-schedule.connection-remove-confirm', c.label),
                        danger: true,
                      })
                    )
                      run(() => api.connections.remove({ id: c.id }));
                  })()
                }
                aria-label={t('ui.foundation.delete')}
                data-testid={`connection-remove-${c.id}`}
              >
                <Icon icon={Trash2} size={14} />
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <section
        className={styles.block}
        aria-label={t('ui.providers-schedule.connection-add-github')}
      >
        <h3 className={styles.title}>{t('ui.providers-schedule.connection-add-github')}</h3>
        <p className={styles.muted}>{t('ui.providers-schedule.connection-add-hint')}</p>
        {gh && !gh.installed && (
          <p className={styles.muted}>{t('ui.providers-schedule.connection-gh-missing')}</p>
        )}
        {gh?.installed && !active && (
          <p className={styles.muted}>{t('ui.providers-schedule.connection-gh-logged-out')}</p>
        )}
        {active && (
          <div className={styles.option} data-testid="connection-gh-option">
            <span>
              {t(
                'ui.providers-schedule.connection-gh-account',
                active.login,
                active.scopes.join(', '),
              )}
            </span>
            {active.wideScopes.length > 0 && (
              <span className={styles.warn}>
                {t('ui.providers-schedule.connection-wide-scopes', active.wideScopes.join(', '))}
              </span>
            )}
            <div className={styles.row}>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => run(() => api.connections.addGithub({ mode: 'gh' }))}
                data-testid="connection-add-gh"
              >
                {t('ui.providers-schedule.connection-use-gh')}
              </Button>
            </div>
          </div>
        )}
        <div className={styles.option}>
          <label className={styles.field}>
            <span>{t('ui.providers-schedule.connection-token')}</span>
            <Input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="github_pat_…"
              data-testid="connection-token"
            />
          </label>
          <span className={styles.muted}>{t('ui.providers-schedule.connection-token-hint')}</span>
          <div className={styles.row}>
            <Button
              size="sm"
              disabled={busy || !token.trim()}
              onClick={() =>
                run(async () => {
                  await api.connections.addGithub({ mode: 'token', token: token.trim() });
                  setToken('');
                })
              }
              data-testid="connection-add-token"
            >
              {t('ui.providers-schedule.connection-add-token')}
            </Button>
          </div>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
};

export default ConnectionsPanel;
