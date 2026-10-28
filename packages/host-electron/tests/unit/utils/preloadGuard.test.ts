import {
  buildProbeScript,
  installPreloadGuard,
  probePreload,
  type GuardedWebContents,
} from '../../../src/utils/preloadGuard';

function fakeWc(results: Array<unknown | 'hang'>) {
  let listener: (() => void) | undefined;
  const wc = {
    on: jest.fn((_e: string, l: () => void) => {
      listener = l;
    }),
    executeJavaScript: jest.fn(() => {
      const r = results.shift();
      return r === 'hang' ? new Promise(() => undefined) : Promise.resolve(r);
    }),
    reloadIgnoringCache: jest.fn(),
    forcefullyCrashRenderer: jest.fn(),
    isDestroyed: jest.fn(() => false),
    getURL: jest.fn(() => 'file:///index.html'),
  };
  return { wc: wc as unknown as GuardedWebContents & typeof wc, fire: () => listener?.() };
}

const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('preloadGuard', () => {
  it('builds a probe over all globals', () => {
    expect(buildProbeScript(['nomiTransport', 'nomiHost'])).toBe(
      `(typeof window["nomiTransport"] !== 'undefined' && typeof window["nomiHost"] !== 'undefined')`,
    );
  });

  it('probe: ok / missing / timeout', async () => {
    expect(await probePreload(fakeWc([true]).wc, ['a'], 50)).toBe('ok');
    expect(await probePreload(fakeWc([false]).wc, ['a'], 50)).toBe('missing');
    expect(await probePreload(fakeWc(['hang']).wc, ['a'], 20)).toBe('timeout');
  });

  it('does nothing when preload is present', async () => {
    const { wc } = fakeWc([true]);
    const log = logger();
    const g = installPreloadGuard(wc, { label: 'main', globals: ['nomiTransport'], logger: log });
    expect(await g.check()).toBe('ok');
    expect(wc.reloadIgnoringCache).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('soft-reloads once when renderer init never ran (probe hangs), then recovers', async () => {
    const { wc } = fakeWc(['hang', true]);
    const log = logger();
    const g = installPreloadGuard(wc, {
      label: 'main',
      globals: ['nomiTransport'],
      logger: log,
      probeTimeoutMs: 10,
    });
    expect(await g.check()).toBe('timeout');
    expect(wc.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(wc.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('preload 未生效'),
      expect.objectContaining({ attempt: 1, strategy: 'reload' }),
    );
    expect(await g.check()).toBe('ok');
    expect(log.info).toHaveBeenCalled();
  });

  it('escalates to renderer recreate, then gives up after maxRecoveries', async () => {
    const { wc } = fakeWc([false, false, false]);
    const log = logger();
    const g = installPreloadGuard(wc, { label: 'main', globals: ['x'], logger: log });
    await g.check();
    await g.check();
    expect(wc.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    expect(wc.reloadIgnoringCache).toHaveBeenCalledTimes(2);
    await g.check();
    expect(wc.reloadIgnoringCache).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalled();
    expect(g.recoveries()).toBe(2);
  });

  it('runs on did-finish-load and ignores navigation errors', async () => {
    const { wc, fire } = fakeWc([]);
    wc.executeJavaScript.mockImplementationOnce(() => Promise.reject(new Error('navigated')));
    installPreloadGuard(wc, { label: 'aiChat', globals: ['nomiHost'], logger: logger() });
    fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(wc.executeJavaScript).toHaveBeenCalled();
    expect(wc.reloadIgnoringCache).not.toHaveBeenCalled();
  });
});
