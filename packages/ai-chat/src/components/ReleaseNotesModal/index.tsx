/**
 * Post-update「更新日志」弹层（TRAE-style）：日期、可勾选关闭的「更新后显示更新日志」、本版本的更新说明、历史链接。
 * 说明由内核按版本号取（updates.releaseNotes：该版本 Release 的 docs/releases/vX.Y.Z.md），界面不内置任何版本的文案。
 * 取消勾选持久化；设置里可重新打开偏好或手动查看。
 */
import { Checkbox, Modal, getLocale, t, useLocale } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { RELEASE_HISTORY_URL, localizeReleaseNotes } from '../../releaseNotes';
import { api, hasTransport, type AppClient } from '../../services/api';
import {
  acknowledgeReleaseNotesVersion,
  getAckedReleaseNotesVersion,
  getShowReleaseNotesAfterUpdate,
  onOpenReleaseNotes,
  setShowReleaseNotesAfterUpdate,
} from '../../services/releaseNotesPrefs';
import { Markdown } from '../Conversation/Markdown';

import styles from './index.module.css';

type ReleaseNotesResult = Awaited<ReturnType<AppClient['updates']['releaseNotes']>>;

function updatesCurrentVersion(): Promise<string | null> {
  if (!hasTransport()) return Promise.resolve(null);
  return api.updates
    .get()
    .then((s) => (s?.currentVersion ? String(s.currentVersion) : null))
    .catch(() => null);
}

function fetchReleaseNotes(version: string): Promise<ReleaseNotesResult> {
  if (!hasTransport()) return Promise.resolve({ version, notes: null });
  return api.updates
    .releaseNotes({ version })
    .catch((): ReleaseNotesResult => ({ version, notes: null }));
}

/** releaseDate 是 ISO 时间（清单生成时刻，UTC）；按 UTC 日历日显示 */
function formatReleaseDate(iso: string, locale: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  if (locale === 'zh-CN') {
    return `${dt.getUTCFullYear()} 年 ${dt.getUTCMonth() + 1} 月 ${dt.getUTCDate()} 日`;
  }
  return dt.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export interface ReleaseNotesModalProps {
  open: boolean;
  /** App version the notes are for (also acknowledged on close). */
  version: string;
  /** null while loading */
  result: ReleaseNotesResult | null;
  onClose: () => void;
}

export const ReleaseNotesModal: React.FC<ReleaseNotesModalProps> = ({
  open,
  version,
  result,
  onClose,
}) => {
  useLocale();
  const locale = getLocale();
  const [showAfter, setShowAfter] = useState(getShowReleaseNotesAfterUpdate);
  /** Track which open session we synced prefs for (avoid setState-in-effect). */
  const [syncedOpen, setSyncedOpen] = useState(false);
  if (open !== syncedOpen) {
    setSyncedOpen(open);
    if (open) setShowAfter(getShowReleaseNotesAfterUpdate());
  }

  const onToggleShow = useCallback((checked: boolean) => {
    setShowAfter(checked);
    setShowReleaseNotesAfterUpdate(checked);
  }, []);

  const handleClose = useCallback(() => {
    acknowledgeReleaseNotesVersion(version);
    onClose();
  }, [onClose, version]);

  const notes = result?.notes;
  const body = useMemo(() => (notes ? localizeReleaseNotes(notes, locale) : ''), [notes, locale]);
  const intro = t('ui.mascot-theme.nomi-version-is-now-available').replace('{0}', version);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('ui.mascot-theme.release-notes')}
      size="lg"
      data-testid="release-notes-modal"
      bodyClassName={styles.body}
    >
      {result?.releaseDate ? (
        <h3 className={styles.date} data-testid="release-notes-date">
          {formatReleaseDate(result.releaseDate, locale)}
        </h3>
      ) : null}
      <label className={styles.prefRow} data-testid="release-notes-show-after-label">
        <Checkbox
          checked={showAfter}
          onChange={(e) => onToggleShow(e.target.checked)}
          data-testid="release-notes-show-after"
        />
        <span>{t('ui.mascot-theme.show-release-notes-after-update')}</span>
      </label>
      <p className={styles.intro} data-testid="release-notes-intro">
        {intro}
      </p>
      {result === null ? (
        <p className={styles.status} role="status" data-testid="release-notes-loading">
          {t('ui.mascot-theme.loading')}
        </p>
      ) : body ? (
        <div className={styles.notes} data-testid="release-notes-body">
          <Markdown text={body} settled />
        </div>
      ) : (
        <p className={styles.status} data-testid="release-notes-unavailable">
          {t('ui.mascot-theme.release-notes-unavailable')}
        </p>
      )}
      <p className={styles.footer}>
        <span>{t('ui.mascot-theme.for-more-release-history-see')}</span>
        <a
          href={RELEASE_HISTORY_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="release-notes-history-link"
        >
          {t('ui.mascot-theme.github-releases')}
        </a>
      </p>
    </Modal>
  );
};

/** Decides when to auto-open after upgrade; listens for Settings → view. */
export const ReleaseNotesHost: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState('');
  const [result, setResult] = useState<ReleaseNotesResult | null>(null);
  /** 只认最后一次打开的请求：连点两次时旧的结果不覆盖新的 */
  const seq = useRef(0);

  const show = useCallback((ver: string) => {
    const mine = ++seq.current;
    setVersion(ver);
    setResult(null);
    setOpen(true);
    void fetchReleaseNotes(ver).then((r) => {
      if (seq.current === mine) setResult(r);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const current = await updatesCurrentVersion();
      if (!alive || !current) return;
      const acked = getAckedReleaseNotesVersion();
      if (!acked) {
        // First launch: seed without popup (onboarding covers first-run).
        acknowledgeReleaseNotesVersion(current);
        return;
      }
      if (acked === current) return;
      if (getShowReleaseNotesAfterUpdate()) {
        show(current);
      } else {
        // Pref off: still mark seen so re-enabling mid-version does not surprise-pop.
        acknowledgeReleaseNotesVersion(current);
      }
    })();
    const off = onOpenReleaseNotes(() => {
      void updatesCurrentVersion().then((v) => {
        if (alive && v) show(v);
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [show]);

  return (
    <ReleaseNotesModal
      open={open}
      version={version}
      result={result}
      onClose={() => setOpen(false)}
    />
  );
};
