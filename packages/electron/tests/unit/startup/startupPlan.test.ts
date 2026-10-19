import {
  DEFAULT_CLOSE_MAIN_ACTION,
  DEFAULT_STARTUP_VIEW,
  normalizeCloseMainAction,
  shouldQuitOnMainClose,
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
  const base = { defaultView: 'mascot', onboardingPending: false } as const;

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

describe('close main window action', () => {
  it('defaults to hide (keep running with mascot + tray) for missing / unknown values', () => {
    expect(DEFAULT_CLOSE_MAIN_ACTION).toBe('hide');
    for (const v of [undefined, null, 'exit', 1]) expect(normalizeCloseMainAction(v)).toBe('hide');
    expect(normalizeCloseMainAction('quit')).toBe('quit');
  });

  it('quits only for "quit" and never re-enters an ongoing quit', () => {
    expect(shouldQuitOnMainClose('quit', false)).toBe(true);
    expect(shouldQuitOnMainClose('quit', true)).toBe(false);
    expect(shouldQuitOnMainClose('hide', false)).toBe(false);
    expect(shouldQuitOnMainClose('hide', true)).toBe(false);
  });
});
