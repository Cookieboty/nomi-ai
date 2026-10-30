jest.unmock('fs');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRecordingAppEvents, type RecordingAppEvents } from '../../../src/core/appEvents';
import { OnboardingService } from '../../../src/onboarding/OnboardingService';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onb-'));
let events: RecordingAppEvents = createRecordingAppEvents();
const make = (userData: string, openChat = jest.fn()) =>
  new OnboardingService({ userData, openChat, events, liveWindows: () => 1 });

describe('OnboardingService', () => {
  beforeEach(() => {
    // 看板娘指令经应用事件总线发布；存活窗口数由宿主报告（make() 里假装有一个窗口）
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
      event: 'onboarding.show',
      payload: s.get(),
      surfaces: null,
    });
    expect(s.mascot({ type: 'say', text: 'hi' })).toBe(true);
    expect(s.mascot({ type: 'say', text: 'yo', gesture: 'wave' })).toBe(true);
    expect(s.mascot({ type: 'gesture', name: 'cheer' })).toBe(true);
    expect(s.mascot({ type: 'reply', phase: 'waiting' })).toBe(true);
    // 只转发语义名：资源名、旧的 motion 指令与其它指令都拒绝
    expect(s.mascot({ type: 'gesture', name: 'think-on' })).toBe(false);
    expect(s.mascot({ type: 'motion', name: 'wave' })).toBe(false);
    expect(s.mascot({ type: 'reply', phase: 'later' })).toBe(false);
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
    expect(events.last('onboarding.profileChanged')).toEqual(saved);
    s.complete();
    await s.reopen();
    expect(make(d).profile()).toEqual(saved);
    expect(s.setProfile({ role: 'astronaut' })).toEqual({ role: null, interests: [] });
  });
});
