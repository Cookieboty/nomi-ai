/**
 * 浏览器标签：网页放在宿主的独立原生窗口里（browserWindow.*），贴着下面这块区域显示。
 *
 * 为什么不是 iframe：子框架会被目标站点的 `X-Frame-Options` / `CSP frame-ancestors` 拒掉
 * （Google、GitHub 这类都拒嵌），浏览器还保留随时拒绝的权利——结果就是那张「已阻止此内容」的
 * Chromium 错误页，应用侧绕不过去。原生窗口里的网页是顶层文档，不参与这些判定，自签证书也走正常的
 * 警告页而不是被静默拦掉。
 *
 * 浏览器预览里没有宿主：退回 iframe（只在没有宿主时走这条路，生产包永远走原生窗口）。
 */
import { Icon, IconButton, t } from '@nomi-ai/ui';
import {
  IconExternalLink as ExternalLink,
  IconWorld as Globe,
  IconRefresh as RotateCw,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  browserWindowHost,
  observeRegion,
  releaseWindow,
  retainWindow,
  useBrowserWindowEvents,
  type BrowserRegion,
} from '../../services/browserWindow';
import { resourcePreviewClient } from '../../services/resourcePreviewClient';
import { parseBrowserUrl } from '../../utils/sideTabs';

import styles from './WorkspacePages.module.css';

/** 标签身份 → 宿主那边的窗口 id（同一个标签反复挂载复用同一个原生窗口） */
export const browserWindowIdFor = (tabKey: string): string => `browser:${tabKey}`.slice(0, 512);

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

const emptyRegion: BrowserRegion = { x: 0, y: 0, width: 0, height: 0 };

/**
 * 进度条兜底超时：宿主只报「加载完成」，没有「加载失败」（mac 的 WKWebView 遇到证书错误 /
 * DNS 失败是静默的，不回调 didFinishNavigation），所以到点就先收掉进度条——
 * 页面本身已经显示在原生窗口里（就是它自己的错误页），别让刷新按钮一直转。
 */
const LOAD_STALL_TIMEOUT_MS = 15_000;

export const BrowserTab: React.FC<{
  tabKey: string;
  url: string;
  title?: string;
  hidden?: boolean;
  onNavigate: (url: string, title?: string) => void;
}> = ({ tabKey, url, hidden, onNavigate }) => {
  const id = browserWindowIdFor(tabKey);
  // 宿主有没有原生浏览器窗口：没有（浏览器预览 / 测试）才退回 iframe
  const hostAvailable = browserWindowHost.available();
  const [draft, setDraft] = useState(url);
  const [loading, setLoading] = useState(Boolean(url) && hostAvailable);
  const [failed, setFailed] = useState<{ message?: string } | null>(null);
  const [urlFor, setUrlFor] = useState(url);
  const surface = useRef<HTMLDivElement>(null);
  const region = useRef<BrowserRegion>(emptyRegion);
  const liveUrl = useRef(url);
  const liveHidden = useRef(Boolean(hidden));
  if (urlFor !== url) {
    setUrlFor(url);
    setDraft(url);
    setFailed(null);
    setLoading(Boolean(url) && hostAvailable);
  }
  liveUrl.current = url;
  liveHidden.current = Boolean(hidden);

  const measure = useCallback((): BrowserRegion => {
    const el = surface.current;
    if (!el) return region.current;
    const r = el.getBoundingClientRect();
    region.current = { x: r.left, y: r.top, width: r.width, height: r.height };
    return region.current;
  }, []);

  // 打开 / 换地址 / 切标签回来：让宿主把窗口摆在这块区域上
  useEffect(() => {
    if (!hostAvailable) return;
    if (!url) {
      browserWindowHost.close(id);
      return;
    }
    if (hidden) {
      browserWindowHost.setRegion(id, measure(), false);
      return;
    }
    let alive = true;
    setLoading(true);
    void browserWindowHost.show(id, url, measure()).then((res) => {
      if (!alive) return;
      if (res.ok) return;
      setLoading(false);
      setFailed({ message: res.message });
    });
    return () => {
      alive = false;
    };
  }, [hostAvailable, id, url, hidden, measure]);

  // 区域变化 / 可见性变化：合并成每帧一次上报
  //
  // visible 交给 observeRegion 判（几何没变但被整页视图盖住时也算不可见），
  // 再叠上 hidden prop：标签切走时一定得藏，不等测量。
  useEffect(() => {
    if (!hostAvailable) return;
    const el = surface.current;
    if (!el) return;
    return observeRegion(el, (report) => {
      region.current = report.region;
      if (!liveUrl.current) return;
      browserWindowHost.setRegion(id, report.region, report.visible && !liveHidden.current);
    });
  }, [hostAvailable, id]);

  // 标签挂上 / 卸下：把 id 记进「这一页现在开着的浏览器窗口全集」
  //
  // 卸载时既发一条 close（当场就收），也从全集里去掉（宿主按全集对账）。
  // 后者才是兜底：视图重建、id 对不上、上一条 close 打空，都不会再留下一个浮在屏幕上的原生视图。
  useEffect(() => {
    if (!hostAvailable) return;
    retainWindow(id);
    return () => {
      releaseWindow(id);
      browserWindowHost.close(id);
    };
  }, [hostAvailable, id]);

  const onLoaded = useCallback((ok: boolean, message?: string) => {
    setLoading(false);
    if (!ok) setFailed({ message });
  }, []);
  const onClosed = useCallback(() => {
    setLoading(false);
    setFailed({ message: 'closed' });
  }, []);
  useBrowserWindowEvents(hostAvailable ? id : null, { onLoaded, onClosed });

  // 加载卡住（证书 / DNS / 站点一直挂连接）时也把进度条收掉，见 LOAD_STALL_TIMEOUT_MS
  useEffect(() => {
    if (!loading || !hostAvailable) return;
    const timer = window.setTimeout(() => setLoading(false), LOAD_STALL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loading, hostAvailable, url]);

  const go = (value = draft) => {
    const href = parseBrowserUrl(value);
    if (!href) return;
    setFailed(null);
    setLoading(true);
    // 同一个地址 = 刷新（原生窗口里的当前页可能已经往前走了，所以走 reload 而不是再导航一次）
    if (href === url && hostAvailable) {
      browserWindowHost.reload(id);
      return;
    }
    onNavigate(href, hostname(href));
  };

  const reload = () => {
    if (!url) return;
    setFailed(null);
    setLoading(true);
    if (hostAvailable) browserWindowHost.reload(id);
  };

  const showFallback = hostAvailable && failed !== null;

  return (
    <div
      className={`${styles.page} ${styles.browser}`}
      hidden={hidden}
      data-testid="browser-tab"
      data-tab-key={tabKey}
    >
      <div className={styles.browserBar} data-loading={(loading && !failed) || undefined}>
        <IconButton
          size="sm"
          label={t('ui.knowledge-local.refresh')}
          icon={
            <Icon
              icon={RotateCw}
              size={14}
              className={loading && !failed ? styles.browserSpin : undefined}
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
        {loading && !failed && (
          <span
            aria-hidden="true"
            className={styles.browserProgress}
            data-testid="browser-loading-bar"
          />
        )}
      </div>
      {url && !showFallback && hostAvailable ? (
        // 占位：真正的网页在宿主的原生窗口里，这块只用来量区域 + 铺底色
        <div className={styles.browserSurface} ref={surface} data-testid="browser-surface" />
      ) : url && !showFallback ? (
        <iframe
          className={styles.frame}
          title={t('ui.session-workspace.open-browser')}
          src={url}
          loading="eager"
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-modals allow-downloads allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin"
          data-testid="browser-frame"
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setFailed({ message: 'frame' });
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
