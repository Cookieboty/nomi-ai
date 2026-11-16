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
import React, { useEffect, useRef, useState } from 'react';

import { resourcePreviewClient } from '../../services/resourcePreviewClient';
import { parseBrowserUrl } from '../../utils/sideTabs';

import styles from './WorkspacePages.module.css';

/** X-Frame-Options / frame-ancestors 拦截停留在 about:blank 时的复核等待窗口（留出慢速首包余量，避免误判） */
export const EMBED_CHECK_DELAY_MS = 1200;
/** WKWebView 静默取消子 frame 导航或目标域名连接黑洞（始终不触发 onLoad/onError）时的兜底超时 */
export const LOAD_STALL_TIMEOUT_MS = 10000;

function extractWebOrigin(raw: string): string | null {
  const parsed = parseBrowserUrl(raw);
  if (!parsed) return null;
  try {
    const u = new URL(parsed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

async function openSystemBrowser(url: string): Promise<void> {
  const safe = parseBrowserUrl(url);
  if (!safe) return;
  try {
    const res = await resourcePreviewClient.external('', safe);
    if (res.ok) return;
  } catch {
    /* 契约通道不可用时退到宿主 window.open 桥 */
  }
  window.open(safe, '_blank', 'noopener,noreferrer');
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
  const [loading, setLoading] = useState(Boolean(url));
  const [reloadSeq, setReloadSeq] = useState(0);
  const [urlFor, setUrlFor] = useState(url);
  const frame = useRef<HTMLIFrameElement>(null);
  const blockTimer = useRef<number | null>(null);
  const stallTimer = useRef<number | null>(null);
  if (urlFor !== url) {
    setUrlFor(url);
    setDraft(url);
    setBlocked(false);
    setLoading(Boolean(url));
  }

  // 地址栏输入或导航时提前建立 DNS 解析与 TCP/TLS 握手，显著降低首包等待延迟
  const warmOrigin = extractWebOrigin(draft) ?? extractWebOrigin(url);
  useEffect(() => {
    if (!warmOrigin || typeof document === 'undefined' || !document.head) return;
    const dns = document.createElement('link');
    dns.rel = 'dns-prefetch';
    dns.href = warmOrigin;
    const pre = document.createElement('link');
    pre.rel = 'preconnect';
    pre.href = warmOrigin;
    pre.crossOrigin = 'anonymous';
    document.head.append(dns, pre);
    return () => {
      dns.remove();
      pre.remove();
    };
  }, [warmOrigin]);

  const inspectFrame = (frameEl: HTMLIFrameElement): 'ok' | 'blocked' | 'pending' => {
    try {
      const loc = frameEl.contentWindow?.location.href;
      if (!loc || loc === 'about:blank') return 'pending';
      const doc = frameEl.contentDocument;
      if (doc && !doc.body?.childElementCount && !doc.body?.textContent?.trim()) return 'pending';
      return 'ok';
    } catch {
      // 跨域读不了 location：页面已经画出来，嵌入成功
      return 'ok';
    }
  };

  useEffect(() => {
    if (blockTimer.current != null) {
      window.clearTimeout(blockTimer.current);
      blockTimer.current = null;
    }
    if (stallTimer.current != null) {
      window.clearTimeout(stallTimer.current);
      stallTimer.current = null;
    }
    if (!url || blocked) return;

    let cancelled = false;
    // 1. 并行经内核毫秒级检查 X-Frame-Options / CSP frame-ancestors 或不存在的域名，
    //    一旦明确禁止内嵌或域名不存在立即结束白屏展示回退页，绝不误杀 localhost 或代理站点
    if (typeof resourcePreviewClient.web === 'function') {
      void resourcePreviewClient
        .web(url)
        .then((res) => {
          if (cancelled || !res) return;
          if (res.code === 'frame-blocked' || res.code === 'dns') {
            setLoading(false);
            setBlocked(true);
          }
        })
        .catch(() => undefined);
    }

    // 2. WKWebView 子 frame 被静默拦截或连接超时始终不触发 onLoad 时的兜底保护
    stallTimer.current = window.setTimeout(() => {
      stallTimer.current = null;
      if (cancelled) return;
      const el = frame.current;
      if (el && inspectFrame(el) === 'ok') {
        setLoading(false);
        return;
      }
      setLoading(false);
      setBlocked(true);
    }, LOAD_STALL_TIMEOUT_MS);

    return () => {
      cancelled = true;
      if (blockTimer.current != null) window.clearTimeout(blockTimer.current);
      if (stallTimer.current != null) window.clearTimeout(stallTimer.current);
    };
  }, [url, reloadSeq, blocked]);

  const go = (value = draft) => {
    const href = parseBrowserUrl(value);
    if (!href) return;
    setBlocked(false);
    setLoading(true);
    if (href === url) setReloadSeq((n) => n + 1);
    onNavigate(href, hostname(href));
  };

  const reload = () => {
    if (!url) return;
    setBlocked(false);
    setLoading(true);
    setReloadSeq((n) => n + 1);
  };

  return (
    <div
      className={`${styles.page} ${styles.browser}`}
      hidden={hidden}
      data-testid="browser-tab"
      data-tab-key={tabKey}
    >
      <div className={styles.browserBar} data-loading={(loading && !blocked) || undefined}>
        <IconButton
          size="sm"
          label={t('ui.knowledge-local.refresh')}
          icon={
            <Icon
              icon={RotateCw}
              size={14}
              className={loading && !blocked ? styles.browserSpin : undefined}
            />
          }
          onClick={reload}
          data-testid="browser-refresh"
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
        {loading && !blocked && (
          <span
            aria-hidden="true"
            className={styles.browserProgress}
            data-testid="browser-loading-bar"
          />
        )}
      </div>
      {url && !blocked ? (
        <iframe
          key={`${url}#${reloadSeq}`}
          ref={frame}
          className={styles.frame}
          title={t('ui.session-workspace.open-browser')}
          src={url}
          loading="eager"
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-modals allow-downloads allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin"
          data-testid="browser-frame"
          onLoad={(e) => {
            const frameEl = e.currentTarget;
            if (stallTimer.current != null) {
              window.clearTimeout(stallTimer.current);
              stallTimer.current = null;
            }
            // X-Frame-Options / CSP frame-ancestors 拦下时通常停在 about:blank，onError 不会触发。
            // 第一次 load 也可能是导航前的空白文档，稍后再看一次再判定失败。
            const finish = (status: 'ok' | 'blocked' | 'pending') => {
              if (status === 'ok') {
                setLoading(false);
                try {
                  const loc = frameEl.contentWindow?.location.href;
                  if (loc && loc !== 'about:blank') onNavigate(url, hostname(url));
                } catch {
                  /* 跨域成功时读不了 href */
                }
              } else if (status === 'blocked') {
                setLoading(false);
                setBlocked(true);
              }
            };
            const status = inspectFrame(frameEl);
            if (status !== 'pending') {
              finish(status);
              return;
            }
            if (blockTimer.current != null) window.clearTimeout(blockTimer.current);
            blockTimer.current = window.setTimeout(() => {
              blockTimer.current = null;
              finish(inspectFrame(frameEl) === 'ok' ? 'ok' : 'blocked');
            }, EMBED_CHECK_DELAY_MS);
          }}
          onError={() => {
            setLoading(false);
            setBlocked(true);
          }}
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
            <button
              type="button"
              className={styles.fallbackActionBtn}
              data-testid="browser-fallback-open-external"
              onClick={() => void openSystemBrowser(url)}
            >
              <Icon icon={ExternalLink} size={14} />
              {t('ui.session-workspace.browser-open-external')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
};
