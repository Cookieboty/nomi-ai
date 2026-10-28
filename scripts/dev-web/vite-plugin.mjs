// 视图在普通浏览器里连开发态内核（docs/design/core-host-decoupling.md §5.2、§11.3；`pnpm dev:web`）。
//
// devTransportPlugin() 返回两个 Vite 插件：
// - serve：`scripts/dev-web/start.mjs` 启动开发服务器时通过环境变量给出 WebSocket 地址与一次性 token，
//   这里把它们以 `window.nomiDevTransport` 注入 index.html（视图的 services/api.ts 只在开发构建里读）；
//   同时把开发服务器的 CORS 收紧到它自己的地址，别的网页读不到注入了 token 的页面。没有这两个环境变量
//   时什么都不做（普通 `pnpm dev` / Electron 开发态不受影响）；
// - build：生产构建里不允许出现 WebSocket 传输（子协议标记、全局名）；出现就让构建失败，防止开发态的
//   入口被打进打包的 Electron 应用。

export const DEV_WS_URL_ENV = 'NOMI_DEV_WS_URL';
export const DEV_WS_TOKEN_ENV = 'NOMI_DEV_WS_TOKEN';
/** 与 @nomi-ai/contract/app 的 NOMI_DEV_TRANSPORT_GLOBAL 一致 */
export const DEV_TRANSPORT_GLOBAL = 'nomiDevTransport';

/** 生产产物里不该出现的标记（contract 的 WS_TOKEN_PREFIX / WS_SURFACE_PREFIX 与全局名） */
const FORBIDDEN_IN_BUILD = ['nomi-token.', 'nomi-surface.', DEV_TRANSPORT_GLOBAL];

function readDevTransport(env) {
  const url = env[DEV_WS_URL_ENV];
  const token = env[DEV_WS_TOKEN_ENV];
  if (!url && !token) return null;
  if (!/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(url ?? '')) {
    throw new Error(`[dev-web] ${DEV_WS_URL_ENV} must be ws://127.0.0.1:<port>`);
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(token ?? '')) {
    throw new Error(`[dev-web] ${DEV_WS_TOKEN_ENV} is missing or malformed`);
  }
  return { url, token };
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
