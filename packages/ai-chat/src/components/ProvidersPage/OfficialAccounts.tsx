/**
 * 编程助手的官方账号（docs/design/cli-plugin-architecture.md §5.10）：一个账号 = 一个 CLI 配置目录，
 * 登录由 CLI 自己完成，Nomi 不保存凭据。多个账号可以在不同标签里同时使用；「默认账号」给新标签
 * 与跟随默认的标签用。界面只拿得到身份（邮箱 / 套餐）。
 */
import { Badge, Button, Icon, Modal, Notice, SettingRow, SettingsGroup, t } from '@nomi-ai/ui';
import { Copy, ExternalLink, LogIn, UserRound } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  cliAccountClient,
  type AccountKind,
  type CliAccount,
  type LoginEvent,
} from '../../services/cliAccountClient';
import { EndpointIcon } from '../EndpointIcon';
import ppStyles from '../ProviderPanel/index.module.css';

import styles from './index.module.css';

const NAME: Record<AccountKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  gemini: 'Gemini',
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 登录弹窗：显示官方登录页链接、设备码，Claude 还要粘贴授权码 */
const LoginDialog: React.FC<{
  kind: AccountKind;
  event: LoginEvent;
  onClose: () => void;
}> = ({ kind, event, onClose }) => {
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
      title={t('登录 {0} 官方账号', NAME[kind])}
      closeLabel={ended ? t('关闭') : t('取消登录')}
      data-testid="cli-account-login"
    >
      <div className={ppStyles.stack} aria-live="polite">
        {event.state === 'starting' && (
          <p className="cd-muted">{t('正在启动 {0} 的登录…', NAME[kind])}</p>
        )}
        {event.url && !ended && (
          <div className={ppStyles.inline}>
            <span className="cd-muted">
              {event.code
                ? t('在浏览器里打开登录页，输入下面的一次性码完成授权：')
                : t('已尝试打开浏览器；没有打开的话，点这里打开登录页：')}
            </span>
            <Button
              size="sm"
              data-testid="cli-account-open-url"
              onClick={() => void cliAccountClient.openUrl(event.url!)}
            >
              <Icon icon={ExternalLink} size={13} />
              {t('打开登录页')}
            </Button>
          </div>
        )}
        {event.code && !ended && (
          <div className={styles.loginCode}>
            <code data-testid="cli-account-code">{event.code}</code>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('复制一次性码')}
              onClick={() => {
                void navigator.clipboard?.writeText(event.code!).then(() => setCopied(true));
              }}
            >
              <Icon icon={Copy} size={13} />
              {copied ? t('已复制') : t('复制')}
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
              aria-label={t('授权码')}
              placeholder={t('在浏览器里授权后，把页面上的授权码粘贴到这里')}
              value={code}
              autoFocus
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={!code.trim()}>
              {t('提交')}
            </Button>
          </form>
        )}
        {event.state === 'waiting' && !event.needsCode && (
          <p className="cd-muted" data-testid="cli-account-waiting">
            {event.message || t('等待你在浏览器里完成授权…')}
          </p>
        )}
        {busy && event.state === 'verifying' && <p className="cd-muted">{t('正在验证…')}</p>}
        {event.state === 'done' && (
          <Notice tone="success" data-testid="cli-account-login-done">
            {t(
              '已登录 {0}。可以把它设为默认账号，或在标签上单独选用它。',
              event.account?.identity?.email ?? event.account?.label ?? '',
            )}
          </Notice>
        )}
        {event.state === 'error' && (
          <Notice tone="danger" data-testid="cli-account-login-error">
            {event.message || t('登录失败')}
          </Notice>
        )}
        <p className="cd-muted" style={{ fontSize: 'var(--cd-font-size-xs)' }}>
          {t(
            '登录在这个账号自己的配置目录里进行，由 {0} 的官方流程完成；Nomi 不保存登录凭据，其它账号不受影响。',
            NAME[kind],
          )}
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
  const startLogin = (accountId?: string) =>
    void cliAccountClient
      .loginStart(kind, accountId)
      .then(setLogin)
      .catch((e) => setMsg({ tone: 'danger', text: errorText(e) }));

  return (
    <SettingsGroup
      title={t('官方账号')}
      data-testid={`cli-accounts-${kind}`}
      description={t(
        '每个账号一个独立的配置目录，登录由 {0} 自己完成，Nomi 不保存登录凭据。多个账号可以在不同标签里同时使用；默认账号用于新标签和跟随默认的标签。',
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
            {busy === 'refresh' ? t('正在刷新…') : t('刷新')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!!busy || loginBusy}
            data-testid="cli-accounts-add"
            onClick={() => startLogin()}
          >
            <Icon icon={LogIn} size={14} />
            {t('添加官方账号')}
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
          {t(
            '部分账号的共享目录软链失败（在 Windows 上常见，需要开发者模式或管理员权限）。会话历史可能不会跨账号共享；官方登录与凭据不受影响。',
          )}
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
                  {t('默认')}
                </Badge>
              )}
              {a.local && <Badge tone="neutral">{t('本机')}</Badge>}
              {a.needsLogin ? (
                <Badge tone="warning" data-testid="cli-account-needs-login">
                  {t('需要重新登录')}
                </Badge>
              ) : (
                !a.loggedIn && <Badge tone="warning">{t('未登录')}</Badge>
              )}
              {a.inUse > 0 && <Badge tone="neutral">{t('{0} 个标签在用', String(a.inUse))}</Badge>}
            </span>
          }
          description={
            <>
              {[a.identity?.email, a.identity?.org].filter(Boolean).join(' · ') ||
                (a.local ? t('这台电脑上 {0} 自己的登录', NAME[kind]) : undefined)}
              {a.duplicateOf && (
                <Notice tone="warning" data-testid="cli-account-duplicate">
                  {t(
                    '这个身份也登录在「{0}」里。同一账号在两处各自刷新登录会让其中一处失效，建议只保留一个。',
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
                  t('默认账号已改为 {0}，跟随默认的标签下一轮生效', a.label),
                )
              }
            >
              {busy === `a:${a.id}` ? t('正在设置…') : t('设为默认')}
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
              {a.needsLogin ? t('重新登录') : t('登录')}
            </Button>
          )}
          {a.terminalCommand && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="cli-account-terminal"
              title={a.terminalCommand}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(a.terminalCommand!)
                  .then(() =>
                    setMsg({ tone: 'success', text: t('已复制终端命令：{0}', a.terminalCommand!) }),
                  )
              }
            >
              <Icon icon={Copy} size={13} />
              {t('终端命令')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => {
              const next = window.prompt(t('账号名称'), a.label);
              if (next && next.trim() && next.trim() !== a.label)
                void run(`r:${a.id}`, () => cliAccountClient.rename(a.id, next.trim()));
            }}
          >
            {t('重命名')}
          </Button>
          {!a.local && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy}
              data-testid="cli-account-remove"
              onClick={() => {
                if (
                  !window.confirm(
                    t(
                      '删除账号「{0}」？会在这个账号的目录里登出 {1}（撤销登录），然后删除这个目录；会话历史保留。',
                      a.label,
                      NAME[kind],
                    ),
                  )
                )
                  return;
                void run(`d:${a.id}`, async () => {
                  try {
                    await cliAccountClient.remove(a.id);
                  } catch (e) {
                    const m = errorText(e);
                    if (
                      /无法确认|强制删除|unknown/i.test(m) &&
                      window.confirm(
                        t(
                          '无法确认是否还有 CLI 在用这个账号。请先在终端退出相关 CLI。确认没有进程占用后，仍要强制删除「{0}」吗？',
                          a.label,
                        ),
                      )
                    ) {
                      await cliAccountClient.remove(a.id, { force: true });
                      return;
                    }
                    throw e;
                  }
                });
              }}
            >
              {t('删除')}
            </Button>
          )}
        </SettingRow>
      ))}
      {accounts.length === 0 && (
        <p className={styles.empty} data-testid="cli-accounts-empty">
          <Icon icon={UserRound} size={14} />
          {t('还没有官方账号。')}
        </p>
      )}
      {login && <LoginDialog kind={kind} event={login} onClose={() => setLogin(null)} />}
    </SettingsGroup>
  );
};
