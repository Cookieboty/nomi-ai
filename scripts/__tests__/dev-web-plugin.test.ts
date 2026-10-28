import { describe, expect, it } from 'vitest';

import { devPageUrl, devTransportPlugin } from '../dev-web/vite-plugin.mjs';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

describe('dev:web vite plugin', () => {
  it('injects only the WebSocket url into index.html, never the token', () => {
    const [serve] = devTransportPlugin({
      env: { NOMI_DEV_WS_URL: 'ws://127.0.0.1:4567', NOMI_DEV_WS_TOKEN: TOKEN },
    }) as Array<{ transformIndexHtml: { handler(html: string): string } }>;
    const html = serve.transformIndexHtml.handler('<html><head></head><body></body></html>');
    expect(html).toContain('window.nomiDevTransport = {"url":"ws://127.0.0.1:4567"}');
    expect(html).not.toContain(TOKEN);
  });

  it('the printed page url carries the token in the fragment', () => {
    const url = new URL(devPageUrl('http://127.0.0.1:6128/', TOKEN));
    expect(url.hash).toBe(`#nomi-token=${TOKEN}`);
    expect(url.pathname + url.search).toBe('/');
  });
});
