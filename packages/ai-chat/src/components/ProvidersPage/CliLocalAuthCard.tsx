import { BUILTIN_MANIFESTS, cliCapability, cliConfigPath, cliName } from '@nomi-ai/cli-catalog';
import {
  Badge,
  Button,
  Icon,
  Modal,
  ModalHostContext,
  Notice,
  SettingRow,
  SettingsGroup,
  t,
} from '@nomi-ai/ui';
import {
  IconExternalLink as ExternalLink,
  IconLogin as LogIn,
  IconLogout as LogOut,
  IconRotateClockwise as RotateCw,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { cliAccountClient } from '../../services/cliAccountClient';
import {
  cliLocalAuthClient,
  type LocalAuthEvent,
  type LocalAuthStatus,
} from '../../services/cliLocalAuthClient';
import type { CliKind } from '../../services/cliSource';
import { confirmDialog } from '../ConfirmDialog';
import { EndpointIcon } from '../EndpointIcon';
import ppStyles from '../ProviderPanel/index.module.css';

import styles from './index.module.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const BlockedNotice: React.FC<{
  kind: CliKind;
  event: LocalAuthEvent;
  onRetry: (useShellProxy?: boolean) => void;
}> = ({ kind, event, onRetry }) => {
  const name = cliName(kind);
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
    <Notice tone="danger" data-testid="cli-local-auth-login-error" data-hint="network-blocked">
      <div className={styles.blocked}>
        <strong>{t('ui.chat-settings.login-blocked-title', name)}</strong>
        <span>{t('ui.chat-settings.login-blocked-why')}</span>
        <span data-testid="cli-local-auth-login-blocked-next">{next}</span>
        <div className={ppStyles.inline}>
          {proxy && !event.useShellProxy ? (
            <Button
              size="sm"
              variant="primary"
              data-testid="cli-local-auth-login-use-proxy"
              onClick={() => onRetry(true)}
            >
              {t('ui.chat-settings.login-blocked-use-proxy-and-retry')}
            </Button>
          ) : (
            <Button size="sm" data-testid="cli-local-auth-login-retry" onClick={() => onRetry()}>
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

const LocalAuthLoginDialog: React.FC<{
  kind: CliKind;
  event: LocalAuthEvent;
  onClose: () => void;
  onRetry: (useShellProxy?: boolean) => void;
}> = ({ kind, event, onClose, onRetry }) => {
  const name = cliName(kind);
  const busy = event.state === 'starting' || event.state === 'verifying';
  const ended = event.state === 'done' || event.state === 'error' || event.state === 'cancelled';
  const close = () => {
    if (!ended) void cliLocalAuthClient.loginCancel(event.id).catch(() => undefined);
    onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      title={t('ui.chat-settings.sign-in-to-an-official-account', name)}
      closeLabel={ended ? t('ui.providers-schedule.close') : t('ui.chat-settings.cancel-sign-in')}
      data-testid="cli-local-auth-login-dialog"
    >
      <div className={ppStyles.stack} aria-live="polite">
        {event.state === 'starting' && (
          <p className="cd-muted">{t('ui.chat-settings.starting-sign-in', name)}</p>
        )}
        {event.url && !ended && (
          <div className={ppStyles.inline}>
            <span className="cd-muted">
              {t('ui.chat-settings.a-browser-window-should-have-opened-if-not')}
            </span>
            <Button
              size="sm"
              data-testid="cli-local-auth-open-url"
              onClick={() => void cliAccountClient.openUrl(event.url!).catch(() => undefined)}
            >
              <Icon icon={ExternalLink} size={13} />
              {t('ui.chat-settings.open-sign-in-page')}
            </Button>
          </div>
        )}
        {event.state === 'waiting' && (
          <p className="cd-muted" data-testid="cli-local-auth-waiting">
            {event.message || t('ui.chat-settings.waiting-for-you-to-finish-authorizing-in-the')}
          </p>
        )}
        {busy && event.state === 'verifying' && (
          <p className="cd-muted">{t('ui.chat-settings.verifying')}</p>
        )}
        {event.state === 'done' && (
          <Notice tone="success" data-testid="cli-local-auth-login-done">
            {t('ui.models.local-auth-done', name)}
          </Notice>
        )}
        {event.state === 'error' && event.hint === 'network-blocked' && (
          <BlockedNotice kind={kind} event={event} onRetry={onRetry} />
        )}
        {event.state === 'error' && event.hint !== 'network-blocked' && (
          <Notice tone="danger" data-testid="cli-local-auth-login-error">
            {event.message || t('ui.chat-settings.sign-in-failed')}
          </Notice>
        )}
        <p className="cd-muted" style={{ fontSize: 'var(--cd-font-size-xs)' }}>
          {t('ui.models.local-auth-dialog-note', name)}
        </p>
      </div>
    </Modal>
  );
};

export const CliLocalAuthCard: React.FC<{ kind: CliKind }> = ({ kind }) => {
  const name = cliName(kind);
  const configPath = cliConfigPath(kind) ?? '—';
  const binName = BUILTIN_MANIFESTS[kind]?.binary.names[0] ?? kind;
  // 清单能力位：只有声明了「应用内本机官方登录管理」的 CLI 才显示登录 / 退出
  const supportsAuth = cliCapability(kind, 'localAuth');

  const [status, setStatus] = useState<LocalAuthStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [busyAction, setBusyAction] = useState<'refresh' | 'logout' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [login, setLogin] = useState<LocalAuthEvent | null>(null);
  const [loginGeneration, setLoginGeneration] = useState(0);
  const loginAttempt = useRef<{ id?: string; events: Map<string, LocalAuthEvent> } | null>(null);

  const loadStatus = useCallback(
    async (probe: boolean) => {
      if (!supportsAuth || !cliLocalAuthClient.available()) return;
      if (probe) setProbing(true);
      try {
        const res = await cliLocalAuthClient.status(kind, probe);
        if (res && typeof res.loggedIn === 'boolean') {
          setStatus(res);
        }
      } catch {
        // 断连或未就绪时保留已有状态，不在未挂载测试环境抛出未捕获拒绝
      } finally {
        if (probe) setProbing(false);
      }
    },
    [kind, supportsAuth],
  );

  useEffect(() => {
    if (!supportsAuth) return;
    let alive = true;
    if (cliLocalAuthClient.available()) {
      void cliLocalAuthClient
        .status(kind, false)
        .then((res) => {
          if (alive && res && typeof res.loggedIn === 'boolean') setStatus(res);
        })
        .catch(() => undefined);
    }
    const off = cliLocalAuthClient.onEvent((e) => {
      const attempt = loginAttempt.current;
      if (e.kind !== kind || !attempt) return;
      if (!attempt.id) {
        attempt.events.set(e.id, e);
        return;
      }
      if (attempt.id !== e.id) return;
      if (e.state === 'cancelled') {
        loginAttempt.current = null;
        setLogin(null);
      } else {
        setLogin(e);
      }
      if (e.state === 'done' || e.state === 'error' || e.state === 'cancelled') {
        void loadStatus(false);
      }
    });
    return () => {
      alive = false;
      off();
      const attempt = loginAttempt.current;
      loginAttempt.current = null;
      if (attempt?.id) void cliLocalAuthClient.loginCancel(attempt.id).catch(() => undefined);
    };
  }, [kind, supportsAuth, loadStatus]);

  if (!supportsAuth) {
    return (
      <SettingsGroup data-testid={`cli-local-only-${kind}`}>
        <SettingRow
          title={t('ui.chat-settings.cli-launcher-local')}
          description={t('ui.models.local-sign-in-only-desc', name, configPath)}
        />
      </SettingsGroup>
    );
  }

  const loginBusy =
    !!login && login.state !== 'done' && login.state !== 'error' && login.state !== 'cancelled';

  const startLogin = () => {
    setLoginGeneration((n) => n + 1);
    setErrorMsg(null);
    const attempt: { id?: string; events: Map<string, LocalAuthEvent> } = { events: new Map() };
    loginAttempt.current = attempt;
    void cliLocalAuthClient
      .loginStart(kind)
      .then((e) => {
        if (loginAttempt.current !== attempt) {
          void cliLocalAuthClient.loginCancel(e.id).catch(() => undefined);
          return;
        }
        attempt.id = e.id;
        const latest = attempt.events.get(e.id) ?? e;
        attempt.events.clear();
        if (latest.state === 'cancelled') {
          loginAttempt.current = null;
          setLogin(null);
        } else {
          setLogin(latest);
        }
      })
      .catch((e) => {
        if (loginAttempt.current !== attempt) return;
        loginAttempt.current = null;
        setLogin(null);
        setErrorMsg(errorText(e));
      });
  };

  const retryLogin = async (useShellProxy?: boolean) => {
    if (useShellProxy) {
      try {
        await cliAccountClient.setNetwork(true);
      } catch (e) {
        setErrorMsg(errorText(e));
      }
    }
    startLogin();
  };

  const handleRefresh = () => {
    setErrorMsg(null);
    setBusyAction('refresh');
    void loadStatus(true).finally(() => setBusyAction(null));
  };

  const handleLogout = async () => {
    if (
      !(await confirmDialog({
        title: t('ui.models.local-auth-logout-title', name),
        message: t('ui.models.local-auth-logout-body', name),
        danger: true,
      }))
    ) {
      return;
    }
    setErrorMsg(null);
    setBusyAction('logout');
    try {
      await cliLocalAuthClient.logout(kind);
      setStatus((prev) => ({
        kind,
        loggedIn: false,
        canLogin: prev?.canLogin ?? true,
        canLogout: prev?.canLogout ?? true,
      }));
      await loadStatus(false);
    } catch (e) {
      setErrorMsg(errorText(e));
    } finally {
      setBusyAction(null);
    }
  };

  const loggedIn = status?.loggedIn === true;
  const canLogin = status?.canLogin ?? false;
  const canLogout = status?.canLogout ?? false;

  const badge =
    probing && !status ? (
      <Badge tone="neutral" data-testid="cli-local-auth-status-badge">
        {t('ui.voice-mascot.checking')}
      </Badge>
    ) : status ? (
      loggedIn ? (
        <Badge tone="success" data-testid="cli-local-auth-status-badge">
          {t('ui.models.local-auth-signed-in')}
        </Badge>
      ) : (
        <Badge tone="warning" data-testid="cli-local-auth-status-badge">
          {t('ui.models.not-signed-in')}
        </Badge>
      )
    ) : null;

  return (
    <SettingsGroup
      title={t('ui.models.local-auth-title')}
      description={t('ui.models.local-auth-desc', name, binName, configPath)}
      data-testid={`cli-local-only-${kind}`}
    >
      {errorMsg && (
        <Notice tone="danger" data-testid="cli-local-auth-error">
          {errorMsg}
        </Notice>
      )}
      <SettingRow
        title={
          <span className={styles.accountTitle}>
            <EndpointIcon backend={kind} size={18} decorative />
            <span>{name}</span>
            {badge}
          </span>
        }
        description={!loggedIn && status?.detail ? status.detail : undefined}
      >
        <Button
          size="sm"
          variant="ghost"
          disabled={!!busyAction || probing || loginBusy}
          aria-label={t('ui.models.local-auth-refresh-aria', name)}
          data-testid="cli-local-auth-refresh"
          onClick={handleRefresh}
        >
          <Icon icon={RotateCw} size={13} />
          {probing || busyAction === 'refresh'
            ? t('ui.chat-settings.refreshing')
            : t('ui.knowledge-local.refresh')}
        </Button>
        {canLogin && (
          <Button
            size="sm"
            variant={loggedIn ? 'secondary' : 'primary'}
            disabled={!!busyAction || loginBusy}
            data-testid="cli-local-auth-login"
            onClick={startLogin}
          >
            <Icon icon={LogIn} size={14} />
            {loggedIn
              ? t('ui.providers-schedule.sign-in-again-action')
              : t('ui.providers-schedule.sign-in')}
          </Button>
        )}
        {loggedIn && canLogout && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busyAction || loginBusy}
            data-testid="cli-local-auth-logout"
            onClick={() => void handleLogout()}
          >
            <Icon icon={LogOut} size={14} />
            {busyAction === 'logout'
              ? t('ui.models.local-auth-logging-out')
              : t('ui.models.local-auth-logout')}
          </Button>
        )}
      </SettingRow>
      {login && (
        <ModalHostContext.Provider value={null}>
          <LocalAuthLoginDialog
            key={loginGeneration}
            kind={kind}
            event={login}
            onClose={() => {
              loginAttempt.current = null;
              setLogin(null);
            }}
            onRetry={(useProxy) => void retryLogin(useProxy)}
          />
        </ModalHostContext.Provider>
      )}
    </SettingsGroup>
  );
};
