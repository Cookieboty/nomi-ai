/**
 * 前端唯一的自定义协议换址点：Wails v3.0.0 只给硬编码的 `wails` scheme 接管请求，
 * `chat-asset://` / `character-pack://` 无法在 WebView 注册（见 docs D-B10-5），改走资产服务器网关。
 * 与 Go 的 assetproto.GatewayURL 逐字一致（`internal/core/assetproto/testdata/gateway_urls.json` 两边共用）。
 */
export const GATEWAY_PREFIX = '/__scheme/';
export const GATEWAY_SCHEMES = ['chat-asset', 'character-pack'] as const;

/** `<scheme>://rest` → `/__scheme/<scheme>/rest`（`\` 编成 %5C，免得浏览器当分隔符）；非本应用协议原样返回 */
export function toGatewayUrl(raw: string): string {
  const i = raw.indexOf('://');
  if (i <= 0) return raw;
  return GATEWAY_PREFIX + raw.slice(0, i) + '/' + raw.slice(i + 3).split('\\').join('%5C');
}

/** 只换本应用的两个协议（大小写不敏感匹配 scheme），其它地址（http/data/blob…）不动 */
export function resolveAssetUrl(raw: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw.trim());
  if (!m || !(GATEWAY_SCHEMES as readonly string[]).includes(m[1]!.toLowerCase())) return raw;
  return toGatewayUrl(raw);
}
