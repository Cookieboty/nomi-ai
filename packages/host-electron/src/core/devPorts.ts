/**
 * Dev-server ports (keep in sync with /dev-ports.json; scripts/dev.mjs passes the
 * resolved values via CD_RENDERER_PORT / CD_CHAT_PORT so env overrides win).
 */
export const DEV_HOST = '127.0.0.1';
export const DEFAULT_DEV_PORTS = { renderer: 6127, chat: 6128 } as const;

const envPort = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : fallback;
};

export const devRendererUrl = (p = ''): string =>
  `http://${DEV_HOST}:${envPort('CD_RENDERER_PORT', DEFAULT_DEV_PORTS.renderer)}${p}`;
export const devChatUrl = (p = ''): string =>
  `http://${DEV_HOST}:${envPort('CD_CHAT_PORT', DEFAULT_DEV_PORTS.chat)}${p}`;
