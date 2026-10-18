import { describe, expect, it } from 'vitest';

import { MASCOT_CSP, mascotCspString } from '../../src/security/csp';

describe('mascot window CSP', () => {
  it('scripts only from the app itself', () => {
    expect(MASCOT_CSP['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    const csp = mascotCspString();
    const script = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(script).toContain("'wasm-unsafe-eval'");
    expect(script).not.toMatch(/'unsafe-inline'|'unsafe-eval'|https?:|\*/);
  });
  it('locks down plugins, frames, base and forms', () => {
    expect(MASCOT_CSP['object-src']).toEqual(["'none'"]);
    expect(MASCOT_CSP['frame-src']).toEqual(["'none'"]);
    expect(MASCOT_CSP['base-uri']).toEqual(["'none'"]);
    expect(MASCOT_CSP['form-action']).toEqual(["'none'"]);
    expect(MASCOT_CSP['default-src']).toEqual(["'self'"]);
  });
  it('no remote origins for fetch', () => {
    expect(MASCOT_CSP['connect-src'].join(' ')).not.toMatch(/https?:|\*/);
  });
  it('serialises to a single meta-safe string', () => {
    expect(mascotCspString()).not.toMatch(/["<>]/);
  });
});
