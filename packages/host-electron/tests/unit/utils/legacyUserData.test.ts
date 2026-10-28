jest.unmock('path');
jest.unmock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LEGACY_DEV_NAMES, migrateLegacyUserData } from '../../../src/utils/legacyUserData';

describe('migrateLegacyUserData', () => {
  let appData: string;
  beforeEach(() => {
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'appdata-'));
  });
  afterEach(() => {
    fs.rmSync(appData, { recursive: true, force: true });
  });

  it('does not migrate old Companion Desk / 智能小助手 product folders', () => {
    fs.mkdirSync(path.join(appData, '智能小助手'));
    const cd = path.join(appData, 'Companion Desk');
    fs.mkdirSync(cd);
    fs.writeFileSync(path.join(cd, 'settings.json'), '{"theme":"ink"}');
    const target = path.join(appData, 'Nomi');
    expect(migrateLegacyUserData(appData, target, []).migrated).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('does nothing when the new directory already holds app data', () => {
    const target = path.join(appData, '@nomi-ai', 'electron');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'ai-providers.json'), '{}');
    expect(migrateLegacyUserData(appData, target, LEGACY_DEV_NAMES).migrated).toBe(false);
  });

  it('does nothing without a legacy directory', () => {
    const target = path.join(appData, '@nomi-ai', 'electron');
    expect(migrateLegacyUserData(appData, target, LEGACY_DEV_NAMES).migrated).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('migrates the dev directory (@ig-live/electron) when names are passed', () => {
    const dev = path.join(appData, '@ig-live', 'electron');
    fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(dev, 'settings.json'), '{}');
    const target = path.join(appData, '@nomi-ai', 'electron');
    expect(migrateLegacyUserData(appData, target, LEGACY_DEV_NAMES).from).toBe(dev);
  });

  it('still migrates when Chromium already created boot-only entries (Crashpad)', () => {
    const dev = path.join(appData, '@ig-live', 'electron');
    fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(dev, 'ai-providers.json'), '{}');
    const target = path.join(appData, '@nomi-ai', 'electron');
    fs.mkdirSync(path.join(target, 'Crashpad'), { recursive: true });
    expect(migrateLegacyUserData(appData, target, LEGACY_DEV_NAMES).migrated).toBe(true);
    expect(fs.existsSync(path.join(target, 'ai-providers.json'))).toBe(true);
  });
});
