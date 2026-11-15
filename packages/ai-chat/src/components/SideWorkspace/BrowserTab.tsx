/**
 * 浏览器标签：在标签区内用 iframe 打开 http(s) 地址。
 * 不少网站禁止被嵌套；嵌套失败时保留地址栏，并可在系统浏览器打开。
 */
import { Icon, IconButton, t } from '@nomi-ai/ui';
import {
  IconExternalLink as ExternalLink,
  IconWorld as Globe,
  IconRefresh as RotateCw,
} from '@tabler/icons-react';
import React, { useRef, useState } from 'react';

import { cliAccountClient } from '../../services/cliAccountClient';
import { parseBrowserUrl } from '../../utils/sideTabs';

import styles from './WorkspacePages.module.css';

async function openSystemBrowser(url: string): Promise<void> {
  try {
    if (await cliAccountClient.openUrl(url)) return;
  } catch {
    /* 没有账户通道时退到系统窗口 */
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

const hostname = (url: string) => {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
};

export const BrowserTab: React.FC<{
  tabKey: string;
  url: string;
  title?: string;
  hidden?: boolean;
  onNavigate: (url: string, title?: string) => void;
}> = ({ tabKey, url, hidden, onNavigate }) => {
  const [draft, setDraft] = useState(url);
  const [blocked, setBlocked] = useState(false);
  const [urlFor, setUrlFor] = useState(url);
  const frame = useRef<HTMLIFrameElement>(null);
  if (urlFor !== url) {
    setUrlFor(url);
    setDraft(url);
    setBlocked(false);
  }

  const go = (value = draft) => {
    const href = parseBrowserUrl(value);
    if (!href) return;
    onNavigate(href, hostname(href));
  };

  return (
    <div
      className={`${styles.page} ${styles.browser}`}
      hidden={hidden}
      data-testid="browser-tab"
      data-tab-key={tabKey}
    >
      <div className={styles.browserBar}>
        <IconButton
          size="sm"
          label={t('ui.knowledge-local.refresh')}
          icon={<Icon icon={RotateCw} size={14} />}
          onClick={() => {
            if (!url) return;
            const el = frame.current;
            if (el) el.src = url;
            else go(url);
          }}
        />
        <form
          className={styles.searchWrap}
          style={{ flex: 1 }}
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input
            className={styles.search}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('ui.session-workspace.browser-location')}
            aria-label={t('ui.session-workspace.browser-location')}
            data-testid="browser-address"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </form>
        {url ? (
          <IconButton
            size="sm"
            label={t('ui.session-workspace.browser-open-external')}
            icon={<Icon icon={ExternalLink} size={14} />}
            onClick={() => void openSystemBrowser(url)}
            data-testid="browser-open-external"
          />
        ) : null}
      </div>
      {url && !blocked ? (
        <iframe
          ref={frame}
          className={styles.frame}
          title={t('ui.session-workspace.open-browser')}
          src={url}
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin"
          referrerPolicy="no-referrer"
          data-testid="browser-frame"
          onLoad={(e) => {
            try {
              const loc = e.currentTarget.contentWindow?.location.href;
              if (loc && loc !== 'about:blank') onNavigate(url, hostname(url));
            } catch {
              // 跨域读不了 location：不算失败，页面可能已经画出来了
            }
          }}
          onError={() => setBlocked(true)}
        />
      ) : (
        <div className={styles.browserFallback} data-testid="browser-fallback">
          <Icon icon={Globe} size={32} />
          <p className={styles.emptyTitle}>
            {url
              ? t('ui.session-workspace.browser-blocked')
              : t('ui.session-workspace.browser-empty')}
          </p>
          {url ? (
            <button type="button" onClick={() => void openSystemBrowser(url)}>
              {t('ui.session-workspace.browser-open-external')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
};
