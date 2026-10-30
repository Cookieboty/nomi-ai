import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClipboardServiceImpl } from '../../src/plugins/ClipboardPlugin';

interface FakeImage {
  isEmpty(): boolean;
  toPNG(): Buffer;
  getSize(): { width: number; height: number };
}

function emptyImage(): FakeImage {
  return {
    isEmpty: () => true,
    toPNG: () => Buffer.alloc(0),
    getSize: () => ({ width: 0, height: 0 }),
  };
}

function pngImage(w: number, h: number, tag: string): FakeImage {
  const data = Buffer.from(`png:${w}x${h}:${tag}`);
  return {
    isEmpty: () => false,
    toPNG: () => data,
    getSize: () => ({ width: w, height: h }),
  };
}

interface FakeClipboardApi {
  readText: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
  readImage: ReturnType<typeof vi.fn>;
}

function createFake(): FakeClipboardApi {
  return {
    readText: vi.fn().mockReturnValue(''),
    writeText: vi.fn(),
    readImage: vi.fn().mockReturnValue(emptyImage()),
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('ClipboardServiceImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('readText / writeText proxy to electron.clipboard', async () => {
    const api = createFake();
    api.readText.mockReturnValue('hello');
    const svc = new ClipboardServiceImpl(api, { pollIntervalMs: 200, watch: false }, logger);
    await svc.writeText('world');
    expect(api.writeText).toHaveBeenCalledWith('world');
    expect(await svc.readText()).toBe('hello');
  });

  it('readImage returns undefined when clipboard image is empty', async () => {
    const api = createFake();
    const svc = new ClipboardServiceImpl(api, { pollIntervalMs: 200, watch: false }, logger);
    expect(await svc.readImage()).toBeUndefined();
  });

  it('readImage returns PNG payload when clipboard image is present', async () => {
    const api = createFake();
    api.readImage.mockReturnValue(pngImage(4, 4, 'a'));
    const svc = new ClipboardServiceImpl(api, { pollIntervalMs: 200, watch: false }, logger);
    const img = await svc.readImage();
    expect(img?.mime).toBe('image/png');
    expect(img?.width).toBe(4);
    expect(img?.height).toBe(4);
    expect(img?.data.byteLength).toBeGreaterThan(0);
  });

  it('tick fires "change" when text mutates', () => {
    const api = createFake();
    api.readText.mockReturnValue('a');
    const svc = new ClipboardServiceImpl(api, { pollIntervalMs: 200, watch: false }, logger);
    const events: unknown[] = [];
    const off = svc.on('change', (p) => events.push(p));
    api.readText.mockReturnValue('b');
    svc.tick();
    off();
    expect(events).toEqual([{ kind: 'text', text: 'b' }]);
  });

  it('tick fires image change when picture mutates', () => {
    const api = createFake();
    api.readImage.mockReturnValue(pngImage(2, 2, 'first'));
    const svc = new ClipboardServiceImpl(api, { pollIntervalMs: 200, watch: false }, logger);
    const events: Array<{ kind: string }> = [];
    svc.on('change', (p) => events.push({ kind: p.kind }));
    api.readImage.mockReturnValue(pngImage(2, 2, 'second'));
    svc.tick();
    expect(events).toEqual([{ kind: 'image' }]);
  });

  it('tick does not fire when nothing changes', () => {
    const api = createFake();
    api.readText.mockReturnValue('same');
    const svc = new ClipboardServiceImpl(api, { pollIntervalMs: 200, watch: false }, logger);
    const events: unknown[] = [];
    svc.on('change', (p) => events.push(p));
    svc.tick();
    svc.tick();
    expect(events).toEqual([]);
  });

  it('polling starts on first change subscription and stops on unsubscribe', () => {
    vi.useFakeTimers();
    try {
      const api = createFake();
      api.readText.mockReturnValue('start');
      const svc = new ClipboardServiceImpl(api, { pollIntervalMs: 200, watch: true }, logger);
      const events: unknown[] = [];
      const off = svc.on('change', (p) => events.push(p));

      api.readText.mockReturnValue('mid');
      vi.advanceTimersByTime(200);
      expect(events).toHaveLength(1);

      off();
      api.readText.mockReturnValue('after-off');
      vi.advanceTimersByTime(400);
      expect(events).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
