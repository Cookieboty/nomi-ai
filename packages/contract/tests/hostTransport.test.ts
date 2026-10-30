import { describe, expect, it } from 'vitest';

import { resolveHostAssetUrl, resolveHostTransport } from '../src/app/index';

const TOKEN = '0123456789abcdef0123456789abcdef';
const URL_ = 'ws://127.0.0.1:4567';
const frag = (ws: string, token: string) => `#${new URLSearchParams({ ws, token }).toString()}`;

describe('resolveHostTransport (Go host)', () => {
  it('reads the loopback WebSocket address and token from the fragment', () => {
    expect(resolveHostTransport(frag(URL_, TOKEN))).toEqual({ url: URL_, token: TOKEN });
    // 片段里的其它参数（测量控制口）不影响
    expect(resolveHostTransport(`${frag(URL_, TOKEN)}&ctl=127.0.0.1%3A1`)).toEqual({
      url: URL_,
      token: TOKEN,
    });
  });

  it('rejects anything that is not a loopback ws:// address', () => {
    for (const ws of [
      'wss://127.0.0.1:4567',
      'ws://localhost:4567',
      'ws://10.0.0.1:4567',
      'ws://127.0.0.1:4567/x',
    ]) {
      expect(resolveHostTransport(frag(ws, TOKEN))).toBeNull();
    }
  });

  it('rejects a missing or malformed token', () => {
    expect(resolveHostTransport(`#ws=${encodeURIComponent(URL_)}`)).toBeNull();
    expect(resolveHostTransport(frag(URL_, 'short'))).toBeNull();
    expect(resolveHostTransport(frag(URL_, `${TOKEN}<`))).toBeNull();
    expect(resolveHostTransport('')).toBeNull();
  });
});

describe('resolveHostAssetUrl (Go host asset gateway)', () => {
  it('maps the app schemes onto the asset-server gateway', () => {
    expect(resolveHostAssetUrl('chat-asset://images/a.png')).toBe(
      '/__scheme/chat-asset/images/a.png',
    );
    expect(resolveHostAssetUrl('Character-Pack://pack/rive/c.riv')).toBe(
      '/__scheme/Character-Pack/pack/rive/c.riv',
    );
    expect(resolveHostAssetUrl('chat-asset://x\\y.png')).toBe('/__scheme/chat-asset/x%5Cy.png');
  });

  it('leaves other addresses alone', () => {
    for (const u of [
      'https://example.com/a.png',
      'data:image/png;base64,AA',
      'blob:x',
      './character/a.webp',
    ]) {
      expect(resolveHostAssetUrl(u)).toBe(u);
    }
  });
});
