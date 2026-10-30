/**
 * Nomi 桌面工具的授权卡片（对话窗口，输入栏上方）：对话窗口开着时内核只把确认请求发到这里，
 * 不打扰看板娘。工具确认：允许 / 拒绝 / 本次运行不再询问；必须看过详情的（破坏性操作、云端首次发送）
 * 默认展开详情，出现 1 秒后才能确认（防误触）。
 * 请求文件夹：授权模型建议的文件夹（内核已校验）/ 另选（系统选择框）/ 拒绝。120 秒未答复由内核自动拒绝。
 */
import type { DesktopConfirmRequest } from '@nomi-ai/types';
import { Badge, Button, Checkbox, Icon, t } from '@nomi-ai/ui';
import { FolderLock, ShieldAlert } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';

import styles from './index.module.css';

const DANGER: Record<
  DesktopConfirmRequest['danger'],
  { label: string; tone: 'neutral' | 'warning' | 'danger' }
> = {
  read: { label: 'ui.chat-settings.read', tone: 'neutral' },
  write: { label: 'ui.chat-settings.write', tone: 'warning' },
  destructive: { label: 'ui.foundation.destructive', tone: 'danger' },
};

const REASON: Record<string, string> = {
  tainted: 'ui.chat-settings.file-contents-were-just-read-this-turn-to',
  destructive: 'ui.chat-settings.destructive-actions-must-be-confirmed-here-moved-to',
  'first-use': 'ui.chat-settings.first-use-of-this-tool-this-session',
};

/** 必须看过详情的确认：卡片出现 1 秒后才能点确认（防误触） */
const ARM_MS = 1000;

const answer = (id: string, allow: boolean, remember = false, pick = false) =>
  void api.desktop.confirmAnswer({ id, allow, remember, pick }).catch(() => undefined);

/** 待答复的确认请求：挂载时补拉（窗口刚打开时请求已经发出），之后跟事件走 */
function useDesktopConfirms(): DesktopConfirmRequest[] {
  const [list, setList] = useState<DesktopConfirmRequest[]>([]);
  useEffect(() => {
    if (!hasTransport()) return;
    let alive = true;
    const add = (r: DesktopConfirmRequest) =>
      setList((l) => (l.some((x) => x.id === r.id) ? l : [...l, r]));
    const offReq = api.on('desktop.confirmRequest', (r) => add(r as DesktopConfirmRequest));
    const offCancel = api.on('desktop.confirmCancel', (id) =>
      setList((l) => l.filter((x) => x.id !== id)),
    );
    void api.desktop
      .state()
      .then((s) => {
        if (alive) for (const r of (s.pending ?? []) as DesktopConfirmRequest[]) add(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      offReq();
      offCancel();
    };
  }, []);
  // 过期的在内核自动拒绝时也会收到取消；这里再按截止时间兜底，避免漏掉事件时卡片一直挂着
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!list.length) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [list.length]);
  return list.filter((r) => r.expiresAt > now - 1000);
}

const secondsLeft = (r: DesktopConfirmRequest) =>
  Math.max(0, Math.ceil((r.expiresAt - Date.now()) / 1000));

const Timer: React.FC<{ req: DesktopConfirmRequest }> = ({ req }) => (
  <span className={styles.timer} data-testid="desktop-confirm-timer">
    {t('ui.chat-settings.auto-deny-in-s', String(secondsLeft(req)))}
  </span>
);

const ScopeCard: React.FC<{ req: DesktopConfirmRequest }> = ({ req }) => {
  const mode =
    req.scopeMode === 'read-write' ? 'ui.foundation.read-write' : 'ui.foundation.read-only';
  return (
    <div
      className={styles.card}
      role="alertdialog"
      aria-label={t('ui.chat-settings.folder-access-request')}
      data-testid="desktop-scope-card"
    >
      <div className={styles.head}>
        <Icon icon={FolderLock} size={16} />
        <span className={styles.title}>{t('ui.chat-settings.folder-access-request')}</span>
        <Badge tone={req.scopeMode === 'read-write' ? 'warning' : 'neutral'}>{t(mode)}</Badge>
        <Timer req={req} />
      </div>
      {req.scopePath ? (
        <code className={styles.code} data-testid="desktop-scope-path">
          {req.scopePath}
        </code>
      ) : (
        <p className={styles.hint}>{t('ui.chat-settings.suggested-folder-cannot-be-granted')}</p>
      )}
      {req.preview && <p className={styles.reason}>{req.preview}</p>}
      <div className={styles.actions}>
        {req.scopePath && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => answer(req.id, true)}
            data-testid="desktop-scope-grant"
          >
            {t('ui.chat-settings.grant-folder')}
          </Button>
        )}
        <Button
          size="sm"
          variant={req.scopePath ? 'secondary' : 'primary'}
          onClick={() => answer(req.id, false, false, true)}
          data-testid="desktop-scope-pick"
        >
          {req.scopePath
            ? t('ui.chat-settings.choose-another-folder')
            : t('ui.cli-monitor.choose-folder-ellipsis')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => answer(req.id, false)}
          data-testid="desktop-scope-deny"
        >
          {t('ui.chat-settings.deny')}
        </Button>
      </div>
    </div>
  );
};

const ToolCard: React.FC<{ req: DesktopConfirmRequest }> = ({ req }) => {
  // 必须看过详情的（破坏性 / 云端首次发送）：详情默认展开，出现 1 秒后才能点确认
  const [detail, setDetail] = useState(req.dialog);
  const [armed, setArmed] = useState(!req.dialog);
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    if (armed) return;
    const id = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(id);
  }, [armed]);
  const d = DANGER[req.danger];
  const canAllow = armed;
  return (
    <div
      className={styles.card}
      data-danger={req.danger}
      role="alertdialog"
      aria-label={t('ui.cli-monitor.tool-permission-required')}
      data-testid="desktop-confirm-card"
    >
      <div className={styles.head}>
        <Icon icon={ShieldAlert} size={16} />
        <span className={styles.title}>{t(req.summary)}</span>
        <Badge tone={d.tone}>{t(d.label)}</Badge>
        <Timer req={req} />
      </div>
      {REASON[req.reason] && <p className={styles.hint}>{t(REASON[req.reason]!)}</p>}
      {detail && (
        <div className={styles.detail} data-testid="desktop-confirm-detail">
          <code className={styles.tool}>{req.tool}</code>
          {req.preview && (
            <>
              <div className={styles.label}>{t('ui.chat-settings.preview-not-yet-run')}</div>
              <pre className={styles.pre}>{req.preview}</pre>
            </>
          )}
          <div className={styles.label}>{t('ui.foundation.arguments')}</div>
          <pre className={styles.pre}>{req.argsJson}</pre>
        </div>
      )}
      {req.rememberable && (
        <label className={styles.remember}>
          <Checkbox
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            data-testid="desktop-confirm-remember"
          />
          {t('ui.chat-settings.don-t-ask-again-for-this-tool-this')}
        </label>
      )}
      <div className={styles.actions}>
        <Button
          size="sm"
          variant={req.danger === 'destructive' ? 'danger' : 'primary'}
          disabled={!canAllow}
          onClick={() => answer(req.id, true, remember)}
          data-testid="desktop-confirm-allow"
        >
          {req.danger === 'destructive'
            ? t('ui.chat-settings.confirm')
            : t('ui.chat-settings.allow')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => answer(req.id, false)}
          data-testid="desktop-confirm-deny"
        >
          {t('ui.chat-settings.deny')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={detail}
          onClick={() => setDetail((v) => !v)}
          data-testid="desktop-confirm-details"
        >
          {detail ? t('ui.model-quality.hide-details') : t('ui.chat-settings.view-details')}
        </Button>
      </div>
    </div>
  );
};

export const DesktopConfirmDock: React.FC = () => {
  const list = useDesktopConfirms();
  if (!list.length) return null;
  return (
    <div className={styles.dock} data-testid="desktop-confirm-dock" aria-live="polite">
      {list.length > 1 && (
        <div className={styles.count}>
          {t('ui.chat-settings.requests-waiting', String(list.length))}
        </div>
      )}
      {list.map((r) =>
        r.kind === 'scope' ? <ScopeCard key={r.id} req={r} /> : <ToolCard key={r.id} req={r} />,
      )}
    </div>
  );
};

export default DesktopConfirmDock;
