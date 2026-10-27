jest.unmock('fs');
const sent: Array<[string, unknown]> = [];
jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (c: string, p: unknown) => sent.push([c, p]),
        },
      },
    ],
  },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OnboardingService } from '../../../src/onboarding/OnboardingService';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onb-'));
const make = (userData: string, openChat = jest.fn()) =>
  new OnboardingService({ userData, openChat });

describe('OnboardingService', () => {
  beforeEach(() => {
    sent.length = 0;
    delete process.env.CD_ONBOARDING;
  });
  it('new users see it once; complete persists; existing users are not bothered', () => {
    const d = dir();
    const s = make(d);
    expect(s.shouldAutoOpen()).toBe(true);
    s.complete(true);
    expect(make(d).get()).toMatchObject({ done: true, skipped: true });
    const old = dir();
    fs.writeFileSync(path.join(old, 'ai-providers.json'), '{}');
    expect(make(old).shouldAutoOpen()).toBe(false);
    process.env.CD_ONBOARDING = 'off';
    expect(make(dir()).shouldAutoOpen()).toBe(false);
  });
  it('reopen opens chat and broadcasts show; only safe mascot commands pass', async () => {
    const open = jest.fn();
    const s = make(dir(), open);
    s.complete();
    await s.reopen();
    expect(open).toHaveBeenCalled();
    expect(sent.some(([c]) => c === 'ai:onboarding:show')).toBe(true);
    expect(s.mascot({ type: 'say', text: 'hi' })).toBe(true);
    expect(s.mascot({ type: 'open-panel', panel: 'x' })).toBe(false);
    expect(s.mascot(null)).toBe(false);
  });
  it('profile: validated, persisted, broadcast, and kept across complete / reopen', async () => {
    const d = dir();
    const s = make(d);
    expect(s.profile()).toEqual({ role: null, interests: [] });
    const saved = s.setProfile({
      role: 'developer',
      interests: ['writing', 'hacking', 'coding', 'coding'],
    });
    // 未知 id 丢掉，按固定顺序去重
    expect(saved).toEqual({ role: 'developer', interests: ['coding', 'writing'] });
    expect(sent).toContainEqual(['ai:onboarding:profile-changed', saved]);
    s.complete();
    await s.reopen();
    expect(make(d).profile()).toEqual(saved);
    expect(s.setProfile({ role: 'astronaut' })).toEqual({ role: null, interests: [] });
  });
});
