/**
 * 设置 → 应用与账号（docs/features/scheduling-calendar.md）：Nomi 能用的应用和账号。
 *
 * - 「已连接」按应用分组（现在只有 GitHub）：每个账号一行，状态、宽权限提示、重新检测、删除；
 *   gh 换了账号时写明「gh 当前账号是 X」，给「改用 X」（确认后改绑，引用它的任务要重新授权）；
 * - 「连接应用」是应用卡片：GitHub 打开对话框（本机 gh 登录 / 粘贴令牌）；GitLab、Notion 即将支持；
 *   本机 MCP 服务器跳到扩展页；
 * - gh 每个主机只能接一条（gh 同一主机同一时间只用一个账号）；已接过的显示「已添加」；
 *   令牌可以接多个账号，同一账号再加时选「替换原来的」（连接不变，任务授权照常）或「保留两个」（起名区分）。
 */
import { Badge, Button, Icon, Input, Modal, t } from '@nomi-ai/ui';
import {
  Puzzle,
  BookOpen,
  GitMerge,
  GitPullRequest,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';

export interface ConnectionView {
  id: string;
  provider?: string;
  label: string;
  auth: { kind: 'cli-login' | 'keychain'; host: string };
  account?: { login: string; host: string };
  observedScopes?: string[];
  wideScopes?: string[];
  name?: string;
  /** gh 在这个主机上的当前账号（和 account 不同 = gh 换了账号） */
  currentLogin?: string;
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
const errCode = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? '');

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

const ConnectionRow: React.FC<{
  c: ConnectionView;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => void;
}> = ({ c, busy, run }) => {
  const switched =
    c.auth.kind === 'cli-login' && c.currentLogin && c.currentLogin !== c.account?.login;
  return (
    <li className={styles.item} data-testid={`connection-${c.id}`}>
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
        {switched && (
          <div className={styles.switched} data-testid={`connection-switched-${c.id}`}>
            <span className={styles.warn}>
              {t(
                'ui.providers-schedule.connection-gh-switched',
                c.currentLogin!,
                c.account?.login ?? '',
              )}
            </span>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  if (
                    await confirmDialog({
                      message: t(
                        'ui.providers-schedule.connection-rebind-confirm',
                        c.currentLogin!,
                      ),
                    })
                  )
                    run(() => api.connections.rebind({ id: c.id }));
                })()
              }
              data-testid={`connection-rebind-${c.id}`}
            >
              {t('ui.providers-schedule.connection-rebind', c.currentLogin!)}
            </Button>
          </div>
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
  );
};

/** 连接 GitHub：本机 gh 登录（每个主机一条）或粘贴令牌（可多个账号） */
const GithubDialog: React.FC<{ items: ConnectionView[]; onClose: () => void }> = ({
  items,
  onClose,
}) => {
  const [host, setHost] = useState('github.com');
  const [gh, setGh] = useState<{ installed: boolean; accounts: GhAccount[] } | null>(null);
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [dup, setDup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const h = host.trim() || 'github.com';

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setGh(null);
      void api.connections
        .detect({ host: h })
        .then((r) => live && setGh((r as unknown as { gh: typeof gh }).gh))
        .catch((e) => live && setError(errText(e)));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [h]);

  const accounts = (gh?.accounts ?? []).filter((a) => a.host === h);
  const active = accounts.find((a) => a.active && a.state === 'success');
  const others = accounts.filter((a) => a !== active);
  const added = items.find((c) => c.auth.kind === 'cli-login' && c.auth.host === h);

  const run = (fn: () => Promise<unknown>, done = true) => {
    setBusy(true);
    setError(null);
    void fn()
      .then(() => {
        if (done) onClose();
      })
      .catch((e) => {
        if (errCode(e) === 'CONNECTIONS_DUPLICATE') setDup(errText(e).split(':')[0] ?? '');
        else setError(errText(e));
      })
      .finally(() => setBusy(false));
  };
  const addToken = (onDuplicate?: 'replace' | 'keep') =>
    run(() =>
      api.connections.addGithub({
        mode: 'token',
        token: token.trim(),
        ...(h !== 'github.com' ? { host: h } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(onDuplicate ? { onDuplicate } : {}),
      }),
    );

  return (
    <Modal open onClose={onClose} title={t('ui.providers-schedule.connection-add-github')}>
      <div className={styles.dialog} data-testid="connection-github-dialog">
        <label className={styles.field}>
          <span>{t('ui.providers-schedule.connection-host')}</span>
          <Input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="github.com"
            data-testid="connection-host"
          />
          <span className={styles.hint}>{t('ui.providers-schedule.connection-host-hint')}</span>
        </label>

        <section className={styles.option} data-testid="connection-gh-option">
          <h4 className={styles.optionTitle}>{t('ui.providers-schedule.connection-use-gh')}</h4>
          {!gh && <span className={styles.muted}>{t('ui.mascot-theme.loading')}</span>}
          {gh && !gh.installed && (
            <span className={styles.muted}>{t('ui.providers-schedule.connection-gh-missing')}</span>
          )}
          {gh?.installed && !active && (
            <span className={styles.muted}>
              {t('ui.providers-schedule.connection-gh-logged-out-host', h)}
            </span>
          )}
          {active && (
            <>
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
            </>
          )}
          {others.length > 0 && (
            <span className={styles.hint} data-testid="connection-gh-others">
              {t(
                'ui.providers-schedule.connection-gh-others',
                others.map((a) => a.login).join('、'),
              )}
            </span>
          )}
          <div className={styles.row}>
            {added ? (
              <span className={styles.added} data-testid="connection-gh-added">
                {t('ui.providers-schedule.connection-gh-added', added.label)}
              </span>
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !active}
                onClick={() =>
                  run(() =>
                    api.connections.addGithub({
                      mode: 'gh',
                      ...(h !== 'github.com' ? { host: h } : {}),
                    }),
                  )
                }
                data-testid="connection-add-gh"
              >
                {active
                  ? t('ui.providers-schedule.connection-use-gh-as', active.login)
                  : t('ui.providers-schedule.connection-use-gh')}
              </Button>
            )}
          </div>
        </section>

        <section className={styles.option}>
          <h4 className={styles.optionTitle}>{t('ui.providers-schedule.connection-token')}</h4>
          <Input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setDup(null);
            }}
            placeholder="github_pat_…"
            aria-label={t('ui.providers-schedule.connection-token')}
            data-testid="connection-token"
          />
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder={t('ui.providers-schedule.connection-name-placeholder')}
            aria-label={t('ui.providers-schedule.connection-name')}
            data-testid="connection-name"
          />
          <span className={styles.hint}>{t('ui.providers-schedule.connection-token-hint')}</span>
          {dup !== null ? (
            <div className={styles.dup} role="alert" data-testid="connection-duplicate">
              <span>{t('ui.providers-schedule.connection-duplicate', dup)}</span>
              <div className={styles.row}>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => addToken('keep')}
                  data-testid="connection-keep-both"
                >
                  {t('ui.providers-schedule.connection-keep-both')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => addToken('replace')}
                  data-testid="connection-replace"
                >
                  {t('ui.providers-schedule.connection-replace')}
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.row}>
              <Button
                size="sm"
                disabled={busy || !token.trim()}
                onClick={() => addToken()}
                data-testid="connection-add-token"
              >
                {t('ui.providers-schedule.connection-add-token')}
              </Button>
            </div>
          )}
        </section>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
};

interface AppCard {
  id: string;
  icon: LucideIcon;
  name: string;
  desc: string;
  soon?: boolean;
}

const APPS: AppCard[] = [
  {
    id: 'github',
    icon: GitPullRequest,
    name: 'GitHub',
    desc: 'ui.providers-schedule.connection-app-github',
  },
  {
    id: 'gitlab',
    icon: GitMerge,
    name: 'GitLab',
    desc: 'ui.providers-schedule.connection-app-gitlab',
    soon: true,
  },
  {
    id: 'notion',
    icon: BookOpen,
    name: 'Notion',
    desc: 'ui.providers-schedule.connection-app-notion',
    soon: true,
  },
  {
    id: 'mcp',
    icon: Puzzle,
    name: 'ui.providers-schedule.connection-app-mcp-name',
    desc: 'ui.providers-schedule.connection-app-mcp',
  },
];

export const ConnectionsPanel: React.FC<{ onOpenExtensions?: () => void }> = ({
  onOpenExtensions,
}) => {
  const { items } = useConnections();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'github' | null>(null);

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void fn()
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false));
  };
  const github = (items ?? []).filter((c) => (c.provider ?? 'github') === 'github');

  return (
    <div className={styles.panel} data-testid="connections-panel">
      <section className={styles.block} aria-label={t('ui.chat-settings.connected')}>
        <h3 className={styles.title}>{t('ui.chat-settings.connected')}</h3>
        {items && !items.length && (
          <p className={styles.muted}>{t('ui.providers-schedule.connections-empty')}</p>
        )}
        {github.length > 0 && (
          <div className={styles.group} data-testid="connections-group-github">
            <h4 className={styles.groupTitle}>
              <Icon icon={GitPullRequest} size={14} />
              GitHub
              <span className={styles.groupCount}>{github.length}</span>
            </h4>
            <ul className={styles.list}>
              {github.map((c) => (
                <ConnectionRow key={c.id} c={c} busy={busy} run={run} />
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </section>

      <section className={styles.block} aria-label={t('ui.providers-schedule.connection-add')}>
        <h3 className={styles.title}>{t('ui.providers-schedule.connection-add')}</h3>
        <ul className={styles.apps}>
          {APPS.map((app) => {
            const name = app.name.startsWith('ui.') ? t(app.name) : app.name;
            return (
              <li key={app.id} className={styles.app} data-soon={app.soon || undefined}>
                <span className={styles.appIcon}>
                  <Icon icon={app.icon} size={18} />
                </span>
                <span className={styles.appBody}>
                  <span className={styles.appName}>{name}</span>
                  <span className={styles.appDesc}>{t(app.desc)}</span>
                </span>
                {app.soon ? (
                  <Badge tone="neutral">{t('ui.providers-schedule.connection-soon')}</Badge>
                ) : app.id === 'mcp' ? (
                  onOpenExtensions && (
                    <Button size="sm" onClick={onOpenExtensions} data-testid="connection-open-mcp">
                      {t('ui.providers-schedule.connection-open-extensions')}
                    </Button>
                  )
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setDialog('github')}
                    data-testid={`connection-app-${app.id}`}
                  >
                    {t('ui.foundation.connect')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      {dialog === 'github' && <GithubDialog items={items ?? []} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default ConnectionsPanel;
