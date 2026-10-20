/**
 * 编程助手的官方账号（docs/design/cli-official-accounts.md §6）：多个官方账号登录与全局切换。
 * 切换会改写该 CLI 的全局登录：用户在终端里直接用的 CLI 也跟着切。界面只拿得到身份（邮箱 / 套餐）。
 */
import { Badge, Button, Card, Icon, Modal, Notice, t } from '@nomi-ai/ui';
import { Copy, ExternalLink, LogIn, UserRound } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  cliAccountClient,
  type AccountIdentity,
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
              '已登录 {0}。在列表里点「切换」就会改用这个账号。',
              event.account?.identity?.email ?? event.account?.label ?? '',
            )}
          </Notice>
        )}
        {event.state === 'error' && (
          <Notice tone="danger" data-testid="cli-account-login-error">
            {event.message || t('登录失败')}
          </Notice>
        )}
        <p className="cd-muted" style={{ fontSize: 12 }}>
          {t('登录在独立的临时目录里进行，你现在的登录不会受影响；凭据由系统钥匙串加密保存。')}
        </p>
      </div>
    </Modal>
  );
};

export const OfficialAccounts: React.FC<{ kind: AccountKind }> = ({ kind }) => {
  const [accounts, setAccounts] = useState<CliAccount[]>([]);
  const [live, setLive] = useState<AccountIdentity | null>(null);
  const [login, setLogin] = useState<LoginEvent | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([
        cliAccountClient.list(kind).catch(() => [] as CliAccount[]),
        cliAccountClient.live(kind).catch(() => null),
      ]),
    [kind],
  );
  const refresh = useCallback(async () => {
    const [list, who] = await load();
    setAccounts(list);
    setLive(who);
  }, [load]);

  useEffect(() => {
    let alive = true;
    const reload = () =>
      void load().then(([list, who]) => {
        if (!alive) return;
        setAccounts(list);
        setLive(who);
      });
    reload();
    const off1 = cliAccountClient.onChanged(reload);
    const off2 = cliAccountClient.onLogin((e) => {
      if (e.kind !== kind) return;
      setLogin((cur) => (cur && cur.id !== e.id ? cur : e));
      if (e.state === 'done') reload();
    });
    return () => {
      alive = false;
      off1();
      off2();
    };
  }, [kind, load]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: 'success', text: ok });
      await refresh();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const liveKnown = !!live && accounts.some((a) => a.identity?.key === live.key);

  return (
    <section className={styles.card} data-testid={`cli-accounts-${kind}`}>
      <div className={ppStyles.stack}>
        <div className={ppStyles.inline}>
          <strong>{t('官方账号')}</strong>
          <span className="cd-muted" data-testid="cli-accounts-live">
            {live
              ? t('终端当前登录：{0}', live.email ?? t('未知账号'))
              : t('终端当前没有登录官方账号')}
          </span>
          <span className="cd-spacer" />
          {live && !liveKnown && (
            <Button
              size="sm"
              disabled={!!busy}
              data-testid="cli-accounts-import"
              onClick={() =>
                void run('import', () => cliAccountClient.importCurrent(kind), t('已导入当前登录'))
              }
            >
              {t('导入当前登录')}
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={
              !!busy ||
              (!!login &&
                login.state !== 'done' &&
                login.state !== 'error' &&
                login.state !== 'cancelled')
            }
            data-testid="cli-accounts-add"
            onClick={() =>
              void cliAccountClient
                .loginStart(kind)
                .then(setLogin)
                .catch((e) => setMsg({ tone: 'danger', text: errorText(e) }))
            }
          >
            <Icon icon={LogIn} size={14} />
            {t('添加官方账号')}
          </Button>
        </div>
        <p className="cd-muted" style={{ fontSize: 12 }}>
          {t(
            '可以登录多个 {0} 官方账号并随时切换。切换会改写 {0} 的全局登录，你在终端里直接运行的 {0} 也会跟着切换；切换前会先保存当前登录的最新凭据并备份。',
            NAME[kind],
          )}
        </p>
        {msg && (
          <Notice tone={msg.tone} data-testid="cli-accounts-msg">
            {msg.text}
          </Notice>
        )}
        {accounts.map((a) => (
          <Card
            key={a.id}
            active={a.active}
            className={ppStyles.card}
            data-testid="cli-account-card"
            title={
              <span className={ppStyles.inline}>
                <EndpointIcon backend={kind} size={22} decorative />
                <span>{a.label}</span>
                {a.identity?.plan && <Badge>{a.identity.plan}</Badge>}
                {a.active && <Badge data-testid="cli-account-current">{t('当前')}</Badge>}
              </span>
            }
            subtitle={[a.identity?.email, a.identity?.org].filter(Boolean).join(' · ') || undefined}
            actions={
              <span className={ppStyles.inline}>
                {!a.active && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!!busy}
                    data-testid="cli-account-activate"
                    onClick={() =>
                      void run(
                        `a:${a.id}`,
                        () => cliAccountClient.activate(a.id, a.kind),
                        t('已切换到 {0}', a.label),
                      )
                    }
                  >
                    {busy === `a:${a.id}` ? t('正在切换…') : t('切换')}
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
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  data-testid="cli-account-remove"
                  onClick={() => {
                    if (
                      window.confirm(
                        t(
                          '从 Nomi 删除账号「{0}」？{1} 现在的登录不会被退出。',
                          a.label,
                          NAME[kind],
                        ),
                      )
                    )
                      void run(`d:${a.id}`, () => cliAccountClient.remove(a.id));
                  }}
                >
                  {t('删除')}
                </Button>
              </span>
            }
          />
        ))}
        {accounts.length === 0 && (
          <p className="cd-muted" data-testid="cli-accounts-empty">
            <Icon icon={UserRound} size={14} /> {t('还没有保存的官方账号')}
          </p>
        )}
      </div>
      {login && <LoginDialog kind={kind} event={login} onClose={() => setLogin(null)} />}
    </section>
  );
};
