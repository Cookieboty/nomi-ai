/**
 * e2e-headed 经应用契约调内核（docs/design/core-host-decoupling.md §5、§12 P1b）。
 *
 * 真实应用的 preload 只暴露 `window.nomiTransport`（契约传输：`contract:request` / `contract:frame`）
 * 与 `window.nomiHost`。用例里需要直接驱动内核时（建标签、配网关、拖看板娘等），在页面里装一个
 * 极小的契约客户端（与 `@nomi-ai/contract` 的线协议一致：`{ c, frame }` 信封，`req` / `res` / `err` 帧），
 * 调用者身份与权限由主进程按页面判定，和界面自己的调用完全一样：
 *
 * - `callContract(page, 'harness.tabs')`、`callContract(page, 'mascot.dragMove', { screenX, screenY })`；
 * - 页面里的循环（连续拖动等）先 `await installContractProbe(page)`，再在 `page.evaluate` 里用
 *   `window.__e2eContract.call(name, input)`。
 *
 * 失败时 reject 一个带 `code` 的 Error（契约错误码，如 FORBIDDEN / UNAVAILABLE）。每个页面只开一个
 * 契约会话（客户端 id 固定），页面刷新后重新安装。
 */
import type { Page } from '@playwright/test';

export interface ContractProbe {
  call(name: string, input?: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    __e2eContract?: ContractProbe;
  }
}

/** 在页面里安装契约客户端（幂等；页面刷新后需要重新安装） */
function installProbe(): void {
  if (window.__e2eContract) return;
  type Frame = {
    t: string;
    id?: string;
    output?: unknown;
    error?: { code: string; message: string };
  };
  type Bridge = {
    invoke(channel: string, payload: unknown): Promise<unknown>;
    on(channel: string, fn: (payload: unknown) => void): () => void;
  };
  const bridge = (): Bridge => {
    const b = (window as unknown as { nomiTransport?: Bridge }).nomiTransport;
    if (!b) throw new Error('window.nomiTransport is missing (preload failed?)');
    return b;
  };
  const c = `e2e-${Math.random().toString(36).slice(2)}`;
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: unknown): void }>();
  let listening = false;
  let seq = 0;
  const listen = () => {
    if (listening) return;
    listening = true;
    bridge().on('contract:frame', (payload) => {
      const env = payload as { c?: string; frame?: Frame } | null;
      if (!env || env.c !== c || !env.frame?.id) return;
      const p = pending.get(env.frame.id);
      if (!p) return;
      pending.delete(env.frame.id);
      if (env.frame.t === 'res') p.resolve(env.frame.output);
      else if (env.frame.t === 'err') {
        const e = new Error(`${env.frame.error?.code}: ${env.frame.error?.message}`);
        (e as Error & { code?: string }).code = env.frame.error?.code;
        p.reject(e);
      }
    });
  };
  window.__e2eContract = {
    call(name, input) {
      return new Promise((resolve, reject) => {
        try {
          listen();
          const id = `q${++seq}`;
          pending.set(id, { resolve, reject });
          bridge()
            .invoke('contract:request', { c, frame: { t: 'req', id, kind: 'call', name, input } })
            .catch((e: unknown) => {
              pending.delete(id);
              reject(e);
            });
        } catch (e) {
          reject(e);
        }
      });
    },
  };
}

/** 等 preload 暴露契约传输 */
export async function waitForTransport(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout });
}

export async function installContractProbe(page: Page): Promise<void> {
  await page.evaluate(installProbe);
}

/** 经契约调一个 query / mutation 过程；input 必须可结构化克隆 */
export async function callContract<T = unknown>(
  page: Page,
  name: string,
  input?: unknown,
): Promise<T> {
  await installContractProbe(page);
  return (await page.evaluate(([n, i]) => window.__e2eContract!.call(n as string, i), [
    name,
    input,
  ] as const)) as T;
}
