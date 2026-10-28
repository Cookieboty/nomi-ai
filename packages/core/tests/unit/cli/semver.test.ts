import { isNewer, parseSemver } from '../../../src/cli/semver';

describe('semver', () => {
  it('parses', () => {
    expect(parseSemver('2.1.299 (Claude Code)')).toEqual([2, 1, 299]);
    expect(parseSemver('nope')).toBeNull();
  });
  it('compares', () => {
    expect(isNewer('2.1.300', '2.1.299')).toBe(true);
    expect(isNewer('2.1.299', '2.1.299')).toBe(false);
    expect(isNewer('2.0.0', '2.1.0')).toBe(false);
  });
});

describe('semver prerelease', () => {
  it('orders prereleases below the release', () => {
    expect(isNewer('0.2.0', '0.2.0-rc.2')).toBe(true);
    expect(isNewer('0.2.0-rc.2', '0.2.0')).toBe(false);
    expect(isNewer('0.2.0-rc.10', '0.2.0-rc.2')).toBe(true);
    expect(isNewer('0.2.0-rc.2', '0.2.0-rc.2')).toBe(false);
    expect(isNewer('0.2.1-alpha.3', '0.2.0-rc.2')).toBe(true);
    expect(isNewer('0.2.0-rc.1', '0.2.0-alpha.9')).toBe(true);
  });
});
