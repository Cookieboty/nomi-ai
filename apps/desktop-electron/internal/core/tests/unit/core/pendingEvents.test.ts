/**
 * 没送达的一次性事件（core/pendingEvents.ts）：没有订阅者时留下（每组最近一次），拉取即取走、过期作废；
 * 送达了就清掉同组里留着的旧事件。
 */
import { CORE_PENDING_GROUPS, createPendingEvents } from '../../../src/core/pendingEvents';

describe('createPendingEvents', () => {
  it('keeps the latest undelivered event of a group until taken', () => {
    const p = createPendingEvents({ groups: CORE_PENDING_GROUPS });
    expect(p.take('nav')).toBeNull();
    p.offer('nav.scheduleRequested', {}, false);
    p.offer('providers.openPanel', {}, false);
    expect(p.take('nav')).toEqual({ event: 'providers.openPanel', payload: {} });
    expect(p.take('nav')).toBeNull();
  });

  it('a delivered event clears the older pending one of its group', () => {
    const p = createPendingEvents({ groups: CORE_PENDING_GROUPS });
    p.offer('nav.voiceSettingsRequested', {}, false);
    p.offer('nav.desktopPanelRequested', {}, true);
    expect(p.take('nav')).toBeNull();
  });

  it('groups are independent; other events are ignored', () => {
    const p = createPendingEvents({ groups: CORE_PENDING_GROUPS });
    const summary = { name: 'a.txt', path: '/a.txt', summary: 's', at: 1 };
    p.offer('desktop.summary', summary, false);
    p.offer('theme.changed', { pref: 'ink' }, false);
    p.offer('nav.scheduleRequested', {}, false);
    expect(p.take('summary')).toEqual({ event: 'desktop.summary', payload: summary });
    expect(p.take('nav')).toEqual({ event: 'nav.scheduleRequested', payload: {} });
    expect(p.take('theme')).toBeNull();
  });

  it('expired events are dropped', () => {
    let now = 1000;
    const p = createPendingEvents({ groups: CORE_PENDING_GROUPS, ttlMs: 50, now: () => now });
    p.offer('providers.openPanel', {}, false);
    now += 51;
    expect(p.take('nav')).toBeNull();
  });
});
