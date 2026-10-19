import {
  DEFAULT_STARTUP_VIEW,
  ONBOARDING_OPEN_DELAY_MS,
  normalizeStartupView,
  planStartup,
  shouldRaiseMainOnReactivate,
} from '../../../src/startup/startupPlan';

describe('normalizeStartupView', () => {
  it('defaults to mascot for missing / unknown / corrupted values', () => {
    expect(DEFAULT_STARTUP_VIEW).toBe('mascot');
    for (const v of [undefined, null, '', 'console', 'MAIN', 1, {}, ['main']]) {
      expect(normalizeStartupView(v)).toBe('mascot');
    }
    expect(normalizeStartupView('main')).toBe('main');
    expect(normalizeStartupView('mascot')).toBe('mascot');
  });
});

describe('planStartup', () => {
  const base = { defaultView: 'mascot', onboardingPending: false, openedAtLogin: false } as const;

  it('mascot (default): keeps the historical launch — only the mascot, no main window', () => {
    expect(planStartup(base)).toEqual({
      openMain: false,
      delayMs: 0,
      activateMain: true,
      activateMascot: true,
    });
  });

  it('main: opens the main interface right after the mascot, mascot does not steal focus', () => {
    expect(planStartup({ ...base, defaultView: 'main' })).toEqual({
      openMain: true,
      delayMs: 0,
      activateMain: true,
      activateMascot: false,
    });
  });

  it('main + login item launch: still opens the main interface but without taking focus', () => {
    const p = planStartup({ ...base, defaultView: 'main', openedAtLogin: true });
    expect(p).toMatchObject({ openMain: true, activateMain: false, activateMascot: false });
  });

  it('mascot + login item launch: unchanged (no main window)', () => {
    expect(planStartup({ ...base, openedAtLogin: true }).openMain).toBe(false);
  });

  it('first-run onboarding wins over the setting and keeps the delayed, focused open', () => {
    for (const defaultView of ['mascot', 'main'] as const) {
      expect(planStartup({ ...base, defaultView, onboardingPending: true })).toEqual({
        openMain: true,
        delayMs: ONBOARDING_OPEN_DELAY_MS,
        activateMain: true,
        activateMascot: true,
      });
    }
  });
});

describe('shouldRaiseMainOnReactivate', () => {
  it('only raises the main interface in main mode (second instance / dock / tray click)', () => {
    expect(shouldRaiseMainOnReactivate('main')).toBe(true);
    expect(shouldRaiseMainOnReactivate('mascot')).toBe(false);
  });
});
