/* global window */
/**
 * 基准脚本（scripts/measure-*.mjs）经应用契约调内核：preload 只暴露 `window.nomiTransport`，
 * 这里在页面里装一个极小的契约客户端（线协议见 packages/contract/src/protocol.ts：`{ c, frame }` 信封，
 * `req` → `res` / `err`）。e2e-headed 用同样的做法（e2e-headed/fixtures/contract.ts）。
 *
 * - `callContract(page, 'window.openAiChat')`
 * - 页面里循环调用：先 `await installContractProbe(page)`，再在 evaluate 里用 `window.__e2eContract.call(name, input)`
 */

/** 在页面里执行：安装 `window.__e2eContract`（幂等） */
function installProbe() {
  if (window.__e2eContract) return;
  const bridge = () => {
    const b = window.nomiTransport;
    if (!b) throw new Error('window.nomiTransport is missing (preload failed?)');
    return b;
  };
  const c = `bench-${Math.random().toString(36).slice(2)}`;
  const pending = new Map();
  let listening = false;
  let seq = 0;
  const listen = () => {
    if (listening) return;
    listening = true;
    bridge().on('contract:frame', (env) => {
      if (!env || env.c !== c || !env.frame || !env.frame.id) return;
      const p = pending.get(env.frame.id);
      if (!p) return;
      pending.delete(env.frame.id);
      if (env.frame.t === 'res') p.resolve(env.frame.output);
      else if (env.frame.t === 'err')
        p.reject(new Error(`${env.frame.error.code}: ${env.frame.error.message}`));
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
            .catch((e) => {
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

export async function installContractProbe(page) {
  await page.evaluate(installProbe);
}

export async function callContract(page, name, input) {
  await installContractProbe(page);
  return page.evaluate(([n, i]) => window.__e2eContract.call(n, i), [name, input]);
}

export async function waitForTransport(page, timeout = 30_000) {
  await page.waitForFunction(() => 'nomiTransport' in window, null, { timeout });
}
