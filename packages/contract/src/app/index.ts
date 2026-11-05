/**
 * `@nomi-ai/contract/app` —— 应用契约（docs/design/core-host-decoupling.md §4、§12 P1）。
 *
 * 视图与内核之间的唯一来源。P1a：AI 门面（`ai.*`，原 `ai:<facade>:<method>` 与 `ai:event`）；
 * P1b：其余 `ai:*` 服务通道与 `window.electronAPI` 的能力，按域分在五个文件里（每个文件只属于一个域），
 * 这里汇总。按 §4.3 只增不删（minor）。
 *
 *   const api = createClient(appContract, transport);   // 视图
 *   implement(appContract, handlers);                     // 内核
 */

import { defineContract } from '../contract';

import { aiEvents, aiProcedures } from './ai';
import { codingErrors, codingEvents, codingEventSurfaces, codingProcedures } from './coding';
import { knowledgeErrors, knowledgeEvents, knowledgeProcedures } from './knowledge';
import { mascotErrors, mascotEvents, mascotEventSurfaces, mascotProcedures } from './mascot';
import { mediaErrors, mediaEvents, mediaEventSurfaces, mediaProcedures } from './media';
import { shellErrors, shellEvents, shellProcedures } from './shell';

/**
 * 各域共用的业务错误码（P1b 基础）：
 * - `UNAVAILABLE`：处理函数依赖的服务没有创建（启动失败 / 平台不支持），视图按「功能不可用」处理
 */
export const APP_ERRORS = ['UNAVAILABLE'] as const;

/** P1b 的五个域（D1..D5）：键是 `contract/src/app/<文件>.ts` 的文件名（Go 内核的处理函数在 `internal/core/<域>handlers`） */
export const APP_DOMAINS = Object.freeze({
  media: { key: 'D1', procedures: mediaProcedures, events: mediaEvents, errors: mediaErrors },
  shell: { key: 'D2', procedures: shellProcedures, events: shellEvents, errors: shellErrors },
  coding: { key: 'D3', procedures: codingProcedures, events: codingEvents, errors: codingErrors },
  knowledge: {
    key: 'D4',
    procedures: knowledgeProcedures,
    events: knowledgeEvents,
    errors: knowledgeErrors,
  },
  mascot: { key: 'D5', procedures: mascotProcedures, events: mascotEvents, errors: mascotErrors },
});

export type AppDomain = keyof typeof APP_DOMAINS;

/** 各部分的名字不得重复：对象展开会静默覆盖，所以在模块加载时检查 */
function assertDisjoint(what: string, parts: Record<string, Iterable<string>>): void {
  const owner = new Map<string, string>();
  for (const [part, names] of Object.entries(parts)) {
    for (const name of names) {
      const prev = owner.get(name);
      if (prev !== undefined) {
        throw new TypeError(
          `[contract/app] ${what} '${name}' is declared by both ${prev} and ${part}`,
        );
      }
      owner.set(name, part);
    }
  }
}

const parts = {
  ai: { procedures: aiProcedures, events: aiEvents, errors: APP_ERRORS },
  ...APP_DOMAINS,
};
assertDisjoint(
  'procedure',
  Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Object.keys(v.procedures)])),
);
assertDisjoint(
  'event',
  Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Object.keys(v.events)])),
);
assertDisjoint(
  'error code',
  Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.errors as readonly string[]])),
);

export const appContract = defineContract({
  version: { major: 2, minor: 3 },
  procedures: {
    ...aiProcedures,
    ...mediaProcedures,
    ...shellProcedures,
    ...codingProcedures,
    ...knowledgeProcedures,
    ...mascotProcedures,
  },
  events: {
    ...aiEvents,
    ...mediaEvents,
    ...shellEvents,
    ...codingEvents,
    ...knowledgeEvents,
    ...mascotEvents,
  },
  eventSurfaces: {
    ...mediaEventSurfaces,
    ...codingEventSurfaces,
    ...mascotEventSurfaces,
  },
  errors: [
    ...APP_ERRORS,
    ...mediaErrors,
    ...shellErrors,
    ...codingErrors,
    ...knowledgeErrors,
    ...mascotErrors,
  ],
});

export type AppContract = typeof appContract;

/** 视图建 WebSocket 传输用的配置 */
export interface HostTransportConfig {
  /** `ws://127.0.0.1:<port>` */
  url: string;
  /** 内核本次启动的随机 token */
  token: string;
}

const HOST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Go 宿主（`apps/desktop-go`，Wails）给视图的 WebSocket 配置：宿主把内核地址与本次启动的随机 token
 * 放在页面地址片段里（`#ws=ws://127.0.0.1:<port>&token=<hex>`，片段不发给服务器）。视图读它连内核
 * （services/api.ts）。地址只认本机回环。
 */
export const NOMI_HOST_WS_FRAGMENT = 'ws';
export const NOMI_HOST_TOKEN_FRAGMENT = 'token';

export function resolveHostTransport(hash: string): HostTransportConfig | null {
  try {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const url = params.get(NOMI_HOST_WS_FRAGMENT);
    const token = params.get(NOMI_HOST_TOKEN_FRAGMENT);
    if (!url || !/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(url)) return null;
    return token && HOST_TOKEN_PATTERN.test(token) ? { url, token } : null;
  } catch {
    return null;
  }
}

/** 视图里要换址的本应用协议（内核给的资源地址用的自定义协议） */
export const HOST_ASSET_SCHEMES = ['chat-asset', 'character-pack'] as const;
/** Go 宿主的资产服务器网关前缀（与 Go `assetproto.GatewayURL` 一致，见 docs D-B10-5） */
export const HOST_ASSET_GATEWAY_PREFIX = '/__scheme/';

/** `<scheme>://rest` → `/__scheme/<scheme>/rest`（`\` 编成 %5C，免得浏览器当分隔符）；不是 `x://` 形式的原样返回 */
export function toHostGatewayUrl(raw: string): string {
  const i = raw.indexOf('://');
  if (i <= 0) return raw;
  return (
    HOST_ASSET_GATEWAY_PREFIX +
    raw.slice(0, i) +
    '/' +
    raw
      .slice(i + 3)
      .split('\\')
      .join('%5C')
  );
}

/**
 * Go 宿主下 `chat-asset://` / `character-pack://` 的换址：Wails 只接管硬编码的 `wails` scheme，自定义协议
 * 改走资产服务器网关（见 docs D-B10-5）。其它地址（http / data / blob / 相对路径）原样返回。
 * 与 Go `assetproto.GatewayURL` 共用 `apps/desktop-go/internal/core/assetproto/testdata/gateway_urls.json`。
 */
export function resolveHostAssetUrl(raw: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw.trim());
  if (!m || !(HOST_ASSET_SCHEMES as readonly string[]).includes(m[1]!.toLowerCase())) return raw;
  return toHostGatewayUrl(raw);
}

export {
  AI_EVENTS,
  AI_METHODS,
  aiArgsToInput,
  aiEvents,
  aiProcedures,
  type AiClientEventName,
  type AiContractEvent,
  type AiFacadePath,
  type AiMethodSpec,
  type AiProcedureName,
} from './ai';

export * as aiSchemas from './schemas';

export {
  codingEvents,
  codingEventSurfaces,
  codingProcedures,
  type CodingEventName,
  type CodingProcedureName,
} from './coding';
export {
  knowledgeEvents,
  knowledgeProcedures,
  type KnowledgeEventName,
  type KnowledgeProcedureName,
} from './knowledge';
export {
  mascotEvents,
  mascotEventSurfaces,
  mascotProcedures,
  type MascotEventName,
  type MascotProcedureName,
} from './mascot';
export {
  mediaEvents,
  mediaEventSurfaces,
  mediaProcedures,
  type MediaEventName,
  type MediaProcedureName,
} from './media';
export {
  shellEvents,
  shellProcedures,
  type ShellEventName,
  type ShellProcedureName,
} from './shell';
