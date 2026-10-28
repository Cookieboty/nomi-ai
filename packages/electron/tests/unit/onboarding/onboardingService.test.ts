jest.unmock('fs');
// OnboardingService 本身不 import electron；看板娘指令还经 ai/mascotCommand（未迁移）广播
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

import { createRecordingAppEvents, type RecordingAppEvents } from '../../../src/core/appEvents';
import {
  ONBOARDING_PROFILE_CHANGED,
  ONBOARDING_SHOW,
  OnboardingService,
} from '../../../src/onboarding/OnboardingService';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onb-'));
let events: RecordingAppEvents = createRecordingAppEvents();
const make = (userData: string, openChat = jest.fn()) =>
  new OnboardingService({ userData, openChat, events });

describe('OnboardingService', () => {
  beforeEach(() => {
    sent.length = 0;
    events = createRecordingAppEvents();
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
    expect(events.published).toContainEqual({
      channel: ONBOARDING_SHOW,
      payload: s.get(),
      surfaces: null,
    });
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
    expect(events.last(ONBOARDING_PROFILE_CHANGED)).toEqual(saved);
    s.complete();
    await s.reopen();
    expect(make(d).profile()).toEqual(saved);
    expect(s.setProfile({ role: 'astronaut' })).toEqual({ role: null, interests: [] });
  });
});
