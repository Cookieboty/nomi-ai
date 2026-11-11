/**
 * 设置 → 关于：品牌 + 版本 + 检查更新（下载完成后「重启并安装」二次确认），一排入口（项目主页 /
 * 更新历史 / 近期更新 / 问题反馈 / 更新设置），以及可关掉的 GitHub Star 提示。
 * 「近期更新」打开更新日志弹层，「更新设置」打开二次弹窗，页面本身不展开任何设置项。
 */
import { brand } from '@nomi-ai/types';
import { Button, Icon, IconButton, t } from '@nomi-ai/ui';
import {
  Bug,
  ExternalLink,
  MessageSquare,
  Globe,
  RefreshCw,
  Settings2,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useState } from 'react';

import { RELEASE_HISTORY_URL } from '../../releaseNotes';
import { openReleaseNotes } from '../../services/releaseNotesPrefs';
import { confirmDialog } from '../ConfirmDialog';

import styles from './AboutSection.module.css';
import { NomiMark } from './NomiMark';
import {
  statusLabel,
  updatesApi,
  UpdatePrefsModal,
  useUpdateRunner,
  useUpdateState,
} from './UpdateSettings';

export const REPO_URL = 'https://github.com/Cookieboty/nomi-ai';
const ISSUES_URL = `${REPO_URL}/issues`;
const STAR_DISMISS_KEY = 'ai-chat:about:starDismissed';

function readStarDismissed(): boolean {
  try {
    return window.localStorage.getItem(STAR_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStarDismissed(): void {
  try {
    window.localStorage.setItem(STAR_DISMISS_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** 外链：系统浏览器打开（与更新日志弹层里的链接同一种方式），外观同次要小按钮 */
const LinkButton: React.FC<{ href: string; icon: LucideIcon; label: string; testId: string }> = ({
  href,
  icon,
  label,
  testId,
}) => (
  <a
    className="cd-btn cd-btn--sm"
    href={href}
    target="_blank"
    rel="noreferrer"
    data-testid={testId}
  >
    <Icon icon={icon} size={14} />
    {label}
  </a>
);

export const AboutSection: React.FC = () => {
  const [state, setState] = useUpdateState();
  const [busy, run] = useUpdateRunner(setState);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [starHidden, setStarHidden] = useState(readStarDismissed);
  const u = updatesApi();
  const s = state;
  const canCheck = !!u && !busy && !!s && s.status !== 'checking' && s.status !== 'downloading';
  const canInstall = !!u && !busy && s?.status === 'downloaded';

  const install = async () => {
    const ok = await confirmDialog({
      title: t('ui.mascot-theme.restart-and-install'),
      message: t('ui.mascot-theme.nomi-will-quit-and-install-conversations-stay-on').replace(
        '{0}',
        s?.availableVersion ?? '',
      ),
      confirmLabel: t('ui.mascot-theme.install-now'),
    });
    if (ok && u) void run(() => u.install());
  };

  return (
    <div className={styles.page} data-testid="settings-about">
      <section className={styles.card} id="settings-updates" data-testid="settings-updates">
        <div className={styles.head}>
          <NomiMark className={styles.mark} size={48} />
          <div className={styles.headText}>
            <h2 className={styles.name}>{brand.appName}</h2>
            <p className={styles.slogan}>{t('ui.chat-settings.about-slogan')}</p>
            <p className={styles.version}>
              {t('ui.chat-settings.about-version', '')}
              <strong data-testid="updates-current-version">{s?.currentVersion ?? '—'}</strong>
              {s?.availableVersion ? (
                <>
                  {' · '}
                  {t('ui.mascot-theme.latest')}{' '}
                  <strong data-testid="updates-available-version">{s.availableVersion}</strong>
                </>
              ) : null}
            </p>
            <p className={styles.status} data-testid="updates-status">
              {u
                ? s
                  ? statusLabel(s)
                  : t('ui.mascot-theme.loading')
                : t('ui.mascot-theme.updates-are-only-available-in-the-desktop-app')}
            </p>
          </div>
          <div className={styles.headActions}>
            {canInstall && (
              <Button
                type="button"
                variant="primary"
                size="sm"
                data-testid="updates-install"
                onClick={() => void install()}
              >
                {t('ui.mascot-theme.restart-and-install')}
              </Button>
            )}
            {u && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canCheck}
                data-testid="updates-check"
                onClick={() => void run(() => u.check())}
              >
                <Icon icon={RefreshCw} size={14} />
                {/* 失败后重新检查会接着重新下载（主进程先取消卡住的下载） */}
                {s?.status === 'error'
                  ? t('ui.mascot-theme.retry')
                  : t('ui.mascot-theme.check-for-updates')}
              </Button>
            )}
          </div>
        </div>
        {s?.status === 'downloading' && (
          <div
            className={styles.bar}
            role="progressbar"
            aria-valuenow={Math.round(s.percent ?? 0)}
            aria-valuemin={0}
            aria-valuemax={100}
            data-testid="updates-progress"
          >
            <div className={styles.barFill} style={{ width: `${s.percent ?? 0}%` }} />
          </div>
        )}
        <div className={styles.links}>
          <LinkButton
            href={REPO_URL}
            icon={Globe}
            label={t('ui.chat-settings.about-homepage')}
            testId="about-homepage"
          />
          <LinkButton
            href={RELEASE_HISTORY_URL}
            icon={ExternalLink}
            label={t('ui.chat-settings.about-changelog')}
            testId="about-changelog"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="updates-open-release-notes"
            onClick={() => openReleaseNotes()}
          >
            <Icon icon={Sparkles} size={14} />
            {t('ui.chat-settings.about-recent-updates')}
          </Button>
          <LinkButton
            href={ISSUES_URL}
            icon={Bug}
            label={t('ui.chat-settings.about-feedback')}
            testId="about-feedback"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="updates-open-prefs"
            onClick={() => setPrefsOpen(true)}
          >
            <Icon icon={Settings2} size={14} />
            {t('ui.chat-settings.about-update-settings')}
          </Button>
        </div>
        {!starHidden && (
          <div className={styles.star} data-testid="about-star">
            <Icon icon={Star} size={20} className={styles.starIcon} />
            <div className={styles.starText}>
              <p className={styles.starLine}>
                {t('ui.chat-settings.about-star-prompt', brand.appName)}
              </p>
              <p className={styles.starSub}>
                {t('ui.chat-settings.about-star-sub', brand.appName)}
              </p>
            </div>
            <div className={styles.starActions}>
              <LinkButton
                href={REPO_URL}
                icon={Star}
                label={t('ui.chat-settings.about-go-star')}
                testId="about-star-link"
              />
              <LinkButton
                href={ISSUES_URL}
                icon={MessageSquare}
                label={t('ui.chat-settings.about-feedback')}
                testId="about-star-feedback"
              />
            </div>
            <IconButton
              icon={<Icon icon={X} size={16} />}
              label={t('ui.chat-settings.about-dismiss-star')}
              size="sm"
              data-testid="about-star-dismiss"
              onClick={() => {
                writeStarDismissed();
                setStarHidden(true);
              }}
            />
          </div>
        )}
      </section>
      <UpdatePrefsModal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        state={s}
        setState={setState}
      />
    </div>
  );
};
