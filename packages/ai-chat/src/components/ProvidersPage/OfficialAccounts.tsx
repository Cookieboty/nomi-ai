import { byCli, cliName } from '@nomi-ai/cli-catalog';
/**
 * 编程助手的官方账号（docs/development/coding-agents.md）：一个账号 = 一个 CLI 配置目录，
 * 登录由 CLI 自己完成，Nomi 不保存凭据。多个账号可以在不同标签里同时使用；「默认账号」给新标签
 * 与跟随默认的标签用。界面只拿得到身份（邮箱 / 套餐）。
 */
import {
  Badge,
  Button,
  Icon,
  Modal,
  Notice,
  SettingRow,
  SettingsGroup,
  Switch,
  t,
} from '@nomi-ai/ui';
import { Copy, ExternalLink, LogIn, RotateCw, UserRound } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  cliAccountClient,
  type AccountKind,
  type CliAccount,
  type CliNetworkState,
  type LoginEvent,
} from '../../services/cliAccountClient';
import { confirmDialog, promptDialog } from '../ConfirmDialog';
import { EndpointIcon } from '../EndpointIcon';
import ppStyles from '../ProviderPanel/index.module.css';

import styles from './index.module.css';

const NAME: Record<AccountKind, string> = byCli(cliName);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 官方服务以 403 拒绝了登录（地区不受支持 / 代理没生效）：说清原因，按「沿用终端代理」的状态给出下一步。
 * Nomi 从 Finder / Dock 启动时拿不到 ~/.zshrc 里的代理变量，见 apps/desktop-go/internal/core/cli/shellproxy.go。
 */
const BlockedNotice: React.FC<{
  kind: AccountKind;
  event: LoginEvent;
  onRetry: (useShellProxy?: boolean) => void;
}> = ({ kind, event, onRetry }) => {
  const proxy = event.shellProxy;
  let next: string;
  if (proxy && event.useShellProxy) {
    next = t('ui.chat-settings.login-blocked-proxy-used', proxy);
  } else if (proxy) {
    next = t('ui.chat-settings.login-blocked-proxy-off', proxy);
  } else {
    next = t('ui.chat-settings.login-blocked-no-proxy');
  }
  return (
    <Notice tone="danger" data-testid="cli-account-login-error" data-hint="network-blocked">
      <div className={styles.blocked}>
        <strong>{t('ui.chat-settings.login-blocked-title', NAME[kind])}</strong>
        <span>{t('ui.chat-settings.login-blocked-why')}</span>
        <span data-testid="cli-account-login-blocked-next">{next}</span>
        <div className={ppStyles.inline}>
          {proxy && !event.useShellProxy ? (
            <Button
              size="sm"
              variant="primary"
              data-testid="cli-account-login-use-proxy"
              onClick={() => onRetry(true)}
            >
              {t('ui.chat-settings.login-blocked-use-proxy-and-retry')}
            </Button>
          ) : (
            <Button size="sm" data-testid="cli-account-login-retry" onClick={() => onRetry()}>
              <Icon icon={RotateCw} size={13} />
              {t('ui.mascot-theme.retry')}
            </Button>
          )}
        </div>
        {event.message && <code className={styles.blockedRaw}>{event.message}</code>}
      </div>
    </Notice>
  );
};

/** 登录弹窗：显示官方登录页链接、设备码，Claude 还要粘贴授权码 */
const LoginDialog: React.FC<{
  kind: AccountKind;
  event: LoginEvent;
  onClose: () => void;
  onRetry: (useShellProxy?: boolean) => void;
}> = ({ kind, event, onClose, onRetry }) => {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const busy = event.state === 'starting' || event.state === 'verifying';
  const ended = event.state === 'done' || event.state === 'error' || event.state === 'cancelled';
  const close = () => {
    if (!ended) void cliAccountClient.loginCancel(event.id).catch(() => undefined);
    onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      title={t('ui.chat-settings.sign-in-to-an-official-account', NAME[kind])}
      closeLabel={ended ? t('ui.providers-schedule.close') : t('ui.chat-settings.cancel-sign-in')}
      data-testid="cli-account-login"
    >
      <div className={ppStyles.stack} aria-live="polite">
        {event.state === 'starting' && (
          <p className="cd-muted">{t('ui.chat-settings.starting-sign-in', NAME[kind])}</p>
        )}
        {event.url && !ended && (
          <div className={ppStyles.inline}>
            <span className="cd-muted">
              {event.code
                ? t('ui.chat-settings.open-the-sign-in-page-in-your-browser')
                : t('ui.chat-settings.a-browser-window-should-have-opened-if-not')}
            </span>
            <Button
              size="sm"
              data-testid="cli-account-open-url"
              onClick={() => void cliAccountClient.openUrl(event.url!)}
            >
              <Icon icon={ExternalLink} size={13} />
              {t('ui.chat-settings.open-sign-in-page')}
            </Button>
          </div>
        )}
        {event.code && !ended && (
          <div className={styles.loginCode}>
            <code data-testid="cli-account-code">{event.code}</code>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('ui.chat-settings.copy-one-time-code')}
              onClick={() => {
                void navigator.clipboard?.writeText(event.code!).then(() => setCopied(true));
              }}
            >
              <Icon icon={Copy} size={13} />
              {copied ? t('ui.usage-tools.copied') : t('ui.knowledge-local.copy')}
            </Button>
          </div>
        )}
        {event.needsCode && !ended && (
          <form
            className={ppStyles.inline}
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) void cliAccountClient.loginInput(event.id, code.trim());
            }}
          >
            <input
              className="cd-input"
              data-testid="cli-account-paste"
              aria-label={t('ui.chat-settings.authorization-code')}
              placeholder={t('ui.chat-settings.after-authorizing-in-the-browser-paste-the-code')}
              value={code}
              autoFocus
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={!code.trim()}>
              {t('ui.chat-settings.submit')}
            </Button>
          </form>
        )}
        {event.state === 'waiting' && !event.needsCode && (
          <p className="cd-muted" data-testid="cli-account-waiting">
            {event.message || t('ui.chat-settings.waiting-for-you-to-finish-authorizing-in-the')}
          </p>
        )}
        {busy && event.state === 'verifying' && (
          <p className="cd-muted">{t('ui.chat-settings.verifying')}</p>
        )}
        {event.state === 'done' && (
          <Notice tone="success" data-testid="cli-account-login-done">
            {t(
              'ui.providers-schedule.signed-in-as-you-can-make-it-the',
              event.account?.identity?.email ?? event.account?.label ?? '',
            )}
          </Notice>
        )}
        {event.state === 'error' && event.hint === 'network-blocked' && (
          <BlockedNotice kind={kind} event={event} onRetry={onRetry} />
        )}
        {event.state === 'error' && event.hint !== 'network-blocked' && (
          <Notice tone="danger" data-testid="cli-account-login-error">
            {event.message || t('ui.chat-settings.sign-in-failed')}
          </Notice>
        )}
        <p className="cd-muted" style={{ fontSize: 'var(--cd-font-size-xs)' }}>
          {t('ui.providers-schedule.sign-in-happens-in-this-account-s-own', NAME[kind])}
        </p>
      </div>
    </Modal>
  );
};

export const OfficialAccounts: React.FC<{ kind: AccountKind }> = ({ kind }) => {
  const [accounts, setAccounts] = useState<CliAccount[]>([]);
  const [login, setLogin] = useState<LoginEvent | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [network, setNetwork] = useState<CliNetworkState | null>(null);
  /** 上次登录用的账号（undefined = 新建账号），给「重试」用 */
  const [loginAccount, setLoginAccount] = useState<string | undefined>(undefined);

  const reload = useCallback(
    () =>
      cliAccountClient
        .list(kind)
        .then(setAccounts)
        .catch(() => undefined),
    [kind],
  );

  useEffect(() => {
    let alive = true;
    void cliAccountClient
      .list(kind)
      .then((l) => alive && setAccounts(l))
      .catch(() => undefined);
    // 打开时用 CLI 自己的状态命令读一次身份（不读凭据）
    void cliAccountClient
      .refresh(kind)
      .then((l) => alive && setAccounts(l))
      .catch(() => undefined);
    void cliAccountClient
      .network()
      .then((n) => alive && setNetwork(n))
      .catch(() => undefined);
    const off1 = cliAccountClient.onChanged(() => void reload());
    const off2 = cliAccountClient.onLogin((e) => {
      if (e.kind !== kind) return;
      setLogin((cur) => (cur && cur.id !== e.id ? cur : e));
      if (e.state === 'done' || e.state === 'error' || e.state === 'cancelled') void reload();
    });
    return () => {
      alive = false;
      off1();
      off2();
    };
  }, [kind, reload]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: 'success', text: ok });
      await reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const loginBusy =
    !!login && login.state !== 'done' && login.state !== 'error' && login.state !== 'cancelled';
  const startLogin = (accountId?: string) => {
    setLoginAccount(accountId);
    void cliAccountClient
      .loginStart(kind, accountId)
      .then(setLogin)
      .catch((e) => setMsg({ tone: 'danger', text: errorText(e) }));
  };
  const setUseShellProxy = (on: boolean) =>
    cliAccountClient
      .setNetwork(on)
      .then(setNetwork)
      .catch((e) => setMsg({ tone: 'danger', text: errorText(e) }));
  const retryLogin = async (useShellProxy?: boolean) => {
    if (useShellProxy) await setUseShellProxy(true);
    startLogin(loginAccount);
  };

  return (
    <SettingsGroup
      title={t('ui.chat-settings.official-accounts')}
      data-testid={`cli-accounts-${kind}`}
      description={t(
        'ui.providers-schedule.each-account-has-its-own-configuration-folder-and',
        NAME[kind],
      )}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            data-testid="cli-accounts-refresh"
            onClick={() => void run('refresh', () => cliAccountClient.refresh(kind))}
          >
            {busy === 'refresh' ? t('ui.usage-tools.refreshing') : t('ui.knowledge-local.refresh')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!!busy || loginBusy}
            data-testid="cli-accounts-add"
            onClick={() => startLogin()}
          >
            <Icon icon={LogIn} size={14} />
            {t('ui.chat-settings.add-official-account')}
          </Button>
        </>
      }
    >
      {msg && (
        <Notice tone={msg.tone} data-testid="cli-accounts-msg">
          {msg.text}
        </Notice>
      )}
      {accounts.some((a) => (a.problems?.length ?? 0) > 0) && (
        <Notice tone="warning" data-testid="cli-accounts-home-problems">
          {t('ui.chat-settings.some-account-shared-directory-links-failed-common-on')}
        </Notice>
      )}
      {accounts.map((a) => (
        <SettingRow
          key={a.id}
          data-testid="cli-account-card"
          data-active={a.active ? '1' : undefined}
          title={
            <span className={styles.accountTitle}>
              <EndpointIcon backend={kind} size={18} decorative />
              <span>{a.label}</span>
              {a.identity?.plan && <Badge tone="neutral">{a.identity.plan}</Badge>}
              {a.active && (
                <Badge tone="success" data-testid="cli-account-current">
                  {t('ui.providers-schedule.default')}
                </Badge>
              )}
              {a.local && <Badge tone="neutral">{t('ui.foundation.local')}</Badge>}
              {a.needsLogin ? (
                <Badge tone="warning" data-testid="cli-account-needs-login">
                  {t('ui.providers-schedule.sign-in-again')}
                </Badge>
              ) : (
                !a.loggedIn && <Badge tone="warning">{t('ui.models.not-signed-in')}</Badge>
              )}
              {a.inUse > 0 && (
                <Badge tone="neutral">
                  {t('ui.providers-schedule.used-by-tab-s', String(a.inUse))}
                </Badge>
              )}
            </span>
          }
          description={
            <>
              {[a.identity?.email, a.identity?.org].filter(Boolean).join(' · ') ||
                (a.local
                  ? t('ui.providers-schedule.s-own-sign-in-on-this-computer', NAME[kind])
                  : undefined)}
              {a.duplicateOf && (
                <Notice tone="warning" data-testid="cli-account-duplicate">
                  {t(
                    'ui.providers-schedule.this-identity-is-also-signed-in-under-when',
                    a.duplicateOf,
                  )}
                </Notice>
              )}
            </>
          }
        >
          {!a.active && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy}
              data-testid="cli-account-activate"
              onClick={() =>
                void run(
                  `a:${a.id}`,
                  () => cliAccountClient.setDefault(kind, a.id),
                  t(
                    'ui.providers-schedule.default-account-changed-to-tabs-that-follow-the',
                    a.label,
                  ),
                )
              }
            >
              {busy === `a:${a.id}`
                ? t('ui.providers-schedule.setting')
                : t('ui.providers-schedule.make-default')}
            </Button>
          )}
          {(!a.loggedIn || a.needsLogin) && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy || loginBusy}
              data-testid="cli-account-login"
              onClick={() => startLogin(a.id)}
            >
              {a.needsLogin
                ? t('ui.providers-schedule.sign-in-again-action')
                : t('ui.providers-schedule.sign-in')}
            </Button>
          )}
          {a.terminalCommand && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="cli-account-terminal"
              title={a.terminalCommand}
              onClick={() =>
                void navigator.clipboard?.writeText(a.terminalCommand!).then(() =>
                  setMsg({
                    tone: 'success',
                    text: t(
                      'ui.providers-schedule.copied-the-terminal-command',
                      a.terminalCommand!,
                    ),
                  }),
                )
              }
            >
              <Icon icon={Copy} size={13} />
              {t('ui.providers-schedule.terminal-command')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={async () => {
              const next = await promptDialog({
                title: t('ui.chat-settings.account-name'),
                defaultValue: a.label,
              });
              if (next && next.trim() && next.trim() !== a.label)
                void run(`r:${a.id}`, () => cliAccountClient.rename(a.id, next.trim()));
            }}
          >
            {t('ui.cli-monitor.rename')}
          </Button>
          {!a.local && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy}
              data-testid="cli-account-remove"
              onClick={async () => {
                if (
                  !(await confirmDialog({
                    message: t(
                      'ui.providers-schedule.remove-the-account-will-be-signed-out-in',
                      a.label,
                      NAME[kind],
                    ),
                    danger: true,
                  }))
                )
                  return;
                void run(`d:${a.id}`, async () => {
                  try {
                    await cliAccountClient.remove(a.id);
                  } catch (e) {
                    // 按错误码判断（文案随语言变）：无法确认外部 CLI 是否在用 → 让用户再确认一次后强制删除
                    if (
                      (e as { code?: unknown }).code === 'unknown-live' &&
                      (await confirmDialog({
                        message: t(
                          'ui.chat-settings.nomi-could-not-confirm-whether-a-cli-is',
                          a.label,
                        ),
                        danger: true,
                      }))
                    ) {
                      await cliAccountClient.remove(a.id, { force: true });
                      return;
                    }
                    throw e;
                  }
                });
              }}
            >
              {t('ui.foundation.delete')}
            </Button>
          )}
        </SettingRow>
      ))}
      {accounts.length === 0 && (
        <p className={styles.empty} data-testid="cli-accounts-empty">
          <Icon icon={UserRound} size={14} />
          {t('ui.providers-schedule.no-official-accounts-yet')}
        </p>
      )}
      {network && (
        <SettingRow
          data-testid="cli-network-shell-proxy"
          title={t('ui.chat-settings.use-the-terminal-s-proxy')}
          description={
            <>
              {t('ui.chat-settings.use-the-terminal-s-proxy-desc')}{' '}
              {network.shellProxy
                ? t('ui.chat-settings.terminal-proxy-detected', network.shellProxy)
                : t('ui.chat-settings.terminal-proxy-not-found')}
            </>
          }
        >
          <Switch
            checked={network.useShellProxy}
            onChange={(v) => void setUseShellProxy(v)}
            label={t('ui.chat-settings.use-the-terminal-s-proxy')}
            data-testid="cli-network-shell-proxy-switch"
          />
        </SettingRow>
      )}
      {login && (
        <LoginDialog
          kind={kind}
          event={login}
          onClose={() => setLogin(null)}
          onRetry={(p) => void retryLogin(p)}
        />
      )}
    </SettingsGroup>
  );
};
