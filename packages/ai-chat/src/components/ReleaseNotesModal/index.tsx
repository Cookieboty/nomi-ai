/**
 * Post-update「更新日志」弹层（TRAE-style）：日期、可勾选关闭的「更新后显示更新日志」、
 * 新增 / 优化 / 修复、历史链接。取消勾选持久化；设置里可重新打开偏好或手动查看。
 */
import { Checkbox, Modal, getLocale, t, useLocale } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import {
  RELEASE_HISTORY_URL,
  latestReleaseNotes,
  releaseNotesFor,
  type ReleaseNotesEntry,
  type ReleaseNotesSectionId,
} from '../../releaseNotes';
import {
  acknowledgeReleaseNotesVersion,
  getAckedReleaseNotesVersion,
  getShowReleaseNotesAfterUpdate,
  onOpenReleaseNotes,
  setShowReleaseNotesAfterUpdate,
} from '../../services/releaseNotesPrefs';

import styles from './index.module.css';

const SECTION_TITLE: Record<ReleaseNotesSectionId, () => string> = {
  new: () => t('ui.mascot-theme.whats-new-new'),
  improvements: () => t('ui.mascot-theme.whats-new-improvements'),
  fixes: () => t('ui.mascot-theme.whats-new-fixes'),
};

function updatesCurrentVersion(): Promise<string | null> {
  const w = window as unknown as {
    electronAPI?: { updates?: { get: () => Promise<{ currentVersion?: string }> } };
  };
  const api = w.electronAPI?.updates;
  if (!api) return Promise.resolve(null);
  return api
    .get()
    .then((s) => (s?.currentVersion ? String(s.currentVersion) : null))
    .catch(() => null);
}

function formatReleaseDate(iso: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (locale === 'zh-CN') return `${y} 年 ${mo} 月 ${d} 日`;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export interface ReleaseNotesModalProps {
  open: boolean;
  notes: ReleaseNotesEntry;
  /** App version to acknowledge on close (usually notes.version / currentVersion). */
  version: string;
  onClose: () => void;
}

export const ReleaseNotesModal: React.FC<ReleaseNotesModalProps> = ({
  open,
  notes,
  version,
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

  const intro = t('ui.mascot-theme.nomi-version-is-now-available').replace('{0}', notes.version);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('ui.mascot-theme.release-notes')}
      size="lg"
      data-testid="release-notes-modal"
      bodyClassName={styles.body}
    >
      <h3 className={styles.date} data-testid="release-notes-date">
        {formatReleaseDate(notes.date, locale)}
      </h3>
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
      {notes.sections.map((sec) =>
        sec.itemKeys.length === 0 ? null : (
          <section key={sec.id} className={styles.section} data-testid={`release-notes-${sec.id}`}>
            <h4 className={styles.sectionTitle}>{SECTION_TITLE[sec.id]()}</h4>
            <ul className={styles.list}>
              {sec.itemKeys.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </section>
        ),
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
  const [notes, setNotes] = useState<ReleaseNotesEntry>(() => latestReleaseNotes());
  const [version, setVersion] = useState(notes.version);

  const show = useCallback((entry: ReleaseNotesEntry, ver: string) => {
    setNotes(entry);
    setVersion(ver);
    setOpen(true);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const current = (await updatesCurrentVersion()) ?? latestReleaseNotes().version;
      if (!alive) return;
      const acked = getAckedReleaseNotesVersion();
      if (!acked) {
        // First launch: seed without popup (onboarding covers first-run).
        acknowledgeReleaseNotesVersion(current);
        return;
      }
      if (acked === current) return;
      if (getShowReleaseNotesAfterUpdate()) {
        show(releaseNotesFor(current), current);
      } else {
        // Pref off: still mark seen so re-enabling mid-version does not surprise-pop.
        acknowledgeReleaseNotesVersion(current);
      }
    })();
    const off = onOpenReleaseNotes(() => {
      void updatesCurrentVersion().then((v) => {
        const ver = v ?? latestReleaseNotes().version;
        show(releaseNotesFor(ver), ver);
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [show]);

  return (
    <ReleaseNotesModal open={open} notes={notes} version={version} onClose={() => setOpen(false)} />
  );
};
