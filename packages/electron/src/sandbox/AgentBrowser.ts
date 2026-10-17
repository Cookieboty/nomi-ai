import { BrowserWindow, session } from 'electron';

import type { AgentBrowserApi, PageSnapshot } from '../desktop/p3tools';
import { ToolError } from '../desktop/toolError';

import { checkRequestUrlSync, createRequestGuard } from './agentBrowserGuard';

const PARTITION = 'agent-browser'; // 非 persist：仅内存，关闭应用即清除

/**
 * 受控浏览器（自研）：独立内存分区、sandbox、无 Node、拒绝所有权限请求 / 下载 / 弹窗，
 * 只能访问公开 http(s) 网址（每次跳转都检查），窗口可见以便用户随时看到智能体在做什么。
 */
export class AgentBrowser implements AgentBrowserApi {
  private win: BrowserWindow | null = null;
  private readonly requestGuard = createRequestGuard();

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());
    // 子资源（图片 / 脚本 / XHR / fetch / WebSocket / iframe）与导航（含重定向每一跳）同一判定：
    // 主机名解析出的每个地址都必须是公网；拒绝内网 / 链路本地 / 云元数据地址
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
      this.requestGuard.decideRequest(details.url).then(
        (v) => cb({ cancel: v.cancel }),
        () => cb({ cancel: true }),
      );
    });
    // 兜底（DNS 重绑定）：实际连接的对端 IP 是内网 → 立即停止加载并拉黑该主机。
    // details.ip 在部分 Electron 版本的类型里没有声明，运行时由 Chromium 提供，取不到时这层不生效
    // （此时仍有上面 onBeforeRequest 的逐请求 DNS 校验）。
    const onPeer = (details: { url: string }) => {
      const ip = (details as { ip?: string }).ip;
      if (this.requestGuard.onConnected(details.url, ip)) {
        const w = this.win;
        if (w && !w.isDestroyed()) w.webContents.stop();
      }
    };
    ses.webRequest.onBeforeRedirect({ urls: ['<all_urls>'] }, onPeer);
    ses.webRequest.onResponseStarted({ urls: ['<all_urls>'] }, onPeer);
    ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, onPeer);
    const win = new BrowserWindow({
      width: 1024,
      height: 720,
      title: '智能体浏览器（沙箱）',
      show: true,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        javascript: true,
      },
    });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (e: Electron.Event, url: string) => {
      // 必须同步决定；异步的 DNS 校验由 onBeforeRequest 负责
      if (checkRequestUrlSync(url).cancel) e.preventDefault();
    };
    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', guard);
    win.on('closed', () => (this.win = null));
    this.win = win;
    return win;
  }

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  private info() {
    const wc = this.ensure().webContents;
    return { url: wc.getURL(), title: wc.getTitle() };
  }

  async open(url: string, signal?: AbortSignal) {
    const win = this.ensure();
    const p = win.loadURL(url);
    const abort = () => win.webContents.stop();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await Promise.race([
        p,
        new Promise((_r, rej) =>
          setTimeout(() => rej(new ToolError('timeout', '网页加载超时')), 30_000),
        ),
      ]);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(
        'load_failed',
        `网页打不开：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    return this.info();
  }

  async read(): Promise<PageSnapshot> {
    const wc = this.ensure().webContents;
    const r = (await wc.executeJavaScript(
      `(() => {
        const t = (document.body && document.body.innerText) || '';
        const links = [...document.querySelectorAll('a[href]')].slice(0, 200)
          .map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
          .filter(l => /^https?:/.test(l.href));
        return { text: t.slice(0, 100000), links };
      })()`,
      true,
    )) as { text: string; links: { text: string; href: string }[] };
    return { ...this.info(), text: r.text, links: r.links };
  }

  private async act(script: string) {
    const wc = this.ensure().webContents;
    const ok = (await wc.executeJavaScript(script, true)) as boolean;
    if (!ok) throw new ToolError('not_found', '页面上没有找到这个元素');
    await new Promise((r) => setTimeout(r, 800));
    return this.info();
  }

  click(selector: string) {
    return this.act(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`,
    );
  }

  type(selector: string, text: string, submit: boolean) {
    return this.act(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || !('value' in el)) return false;
        el.focus(); el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));
        if (${submit}) { if (el.form) { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); }
          else el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); }
        return true; })()`,
    );
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    void session.fromPartition(PARTITION).clearStorageData();
  }
}
