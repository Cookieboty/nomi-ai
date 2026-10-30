// 视图在普通浏览器里连开发态内核（docs/design/core-host-decoupling.md §5.2、§11.3；`pnpm dev:web`）。
//
// devTransportPlugin() 返回两个 Vite 插件：
// - serve：`scripts/dev-web/start.mjs` 启动开发服务器时通过环境变量给出 WebSocket 地址，这里把它以
//   `window.nomiDevTransport = { url }` 注入 index.html（视图的 services/api.ts 只在开发构建里读）。
//   **token 不进页面**：本机任何进程都能请求 index.html，放在页面里就等于公开；token 只在 dev:web 打印的地址
//   片段里（`#nomi-token=…`，片段不发给服务器），页面读到后存 sessionStorage 并从地址栏抹掉。同时把开发服务器的
//   CORS 收紧到它自己的地址。没有这个环境变量时什么都不做（普通 `pnpm dev` / Electron 开发态不受影响）；
// - build：生产构建里不允许出现开发态入口（全局名 nomiDevTransport）；出现就让构建失败，防止开发态的
//   入口被打进打包的应用。WebSocket 传输本身（子协议标记）是正式功能：Go 宿主（apps/desktop-go）没有 preload，
//   同一份构建产物运行时经它连内核，只认页面地址片段里宿主给的 127.0.0.1 地址与 token（contract resolveHostTransport）。

export const DEV_WS_URL_ENV = 'NOMI_DEV_WS_URL';
/** 与 @nomi-ai/contract/app 的 NOMI_DEV_TOKEN_FRAGMENT 一致 */
export const DEV_TOKEN_FRAGMENT = 'nomi-token';
/** 与 @nomi-ai/contract/app 的 NOMI_DEV_TRANSPORT_GLOBAL 一致 */
export const DEV_TRANSPORT_GLOBAL = 'nomiDevTransport';

/** 生产产物里不该出现的标记：开发态内核的全局名（只在 import.meta.env.DEV 分支里读） */
const FORBIDDEN_IN_BUILD = [DEV_TRANSPORT_GLOBAL];

function readDevTransport(env) {
  const url = env[DEV_WS_URL_ENV];
  if (!url) return null;
  if (!/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(url)) {
    throw new Error(`[dev-web] ${DEV_WS_URL_ENV} must be ws://127.0.0.1:<port>`);
  }
  // 只注入地址：token 不进页面（见文件头）
  return { url };
}

/** dev:web 打印 / 冒烟打开的页面地址：token 放在片段里 */
export function devPageUrl(base, token) {
  return `${base}#${DEV_TOKEN_FRAGMENT}=${encodeURIComponent(token)}`;
}

/** JSON 放进 <script>：转义 `<`，避免值里出现 `</script>` */
function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function devTransportPlugin({ env = process.env } = {}) {
  const config = readDevTransport(env);
  return [
    {
      name: 'nomi-dev-transport',
      apply: 'serve',
      config(userConfig) {
        if (!config) return;
        const server = (userConfig.server ??= {});
        const host = server.host ?? '127.0.0.1';
        const port = server.port;
        const origins = [`http://${host}:${port}`, `http://localhost:${port}`];
        server.cors = { origin: origins };
      },
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          if (!config) return html;
          const script = `<script>window.${DEV_TRANSPORT_GLOBAL} = ${inlineJson(config)};</script>`;
          return html.replace(/<head>/i, (m) => `${m}\n    ${script}`);
        },
      },
    },
    {
      name: 'nomi-dev-transport-guard',
      apply: 'build',
      generateBundle(_options, bundle) {
        for (const [file, out] of Object.entries(bundle)) {
          const text =
            out.type === 'chunk' ? out.code : typeof out.source === 'string' ? out.source : '';
          const hit = FORBIDDEN_IN_BUILD.find((m) => text.includes(m));
          if (hit) {
            this.error(
              `[dev-web] ${file} contains "${hit}": the dev-only WebSocket transport must not ship ` +
                '(keep it behind import.meta.env.DEV in services/api.ts)',
            );
          }
        }
      },
    },
  ];
}
