import { parseIcs, expand, toIcs, extractCalendarData, caldavQuery } from '../../../src/local/ics';
import {
  LOCAL_LLMS,
  LLAMA_RUNTIME,
  fitLevel,
  recommend,
  runtimeFor,
  serverArgs,
} from '../../../src/local/llmCatalog';
import { looksSecret } from '../../../src/local/LocalHubService';

describe('llmCatalog', () => {
  it('只收录宽松许可证、带校验值的模型', () => {
    for (const m of LOCAL_LLMS) {
      expect(['Apache-2.0', 'MIT']).toContain(m.license);
      expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(m.bytes).toBeGreaterThan(1e8);
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/.+\.gguf$/);
      expect(m.family).not.toMatch(/llama|gemma/i);
    }
    expect(LLAMA_RUNTIME.license).toBe('MIT');
    for (const a of LLAMA_RUNTIME.assets) expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('按内存推荐', () => {
    expect(recommend(2).id).toBe(LOCAL_LLMS[0].id);
    const big = recommend(64);
    expect(big.minRamGb).toBeLessThanOrEqual(64);
    expect(recommend(8).minRamGb).toBeLessThanOrEqual(8);
    expect(recommend(8).minRamGb).toBeGreaterThanOrEqual(recommend(4).minRamGb);
  });
  it('fitLevel', () => {
    const m = { ...LOCAL_LLMS[0], minRamGb: 8 };
    expect(fitLevel(m, 16)).toBe('ok');
    expect(fitLevel(m, 6)).toBe('tight');
    expect(fitLevel(m, 4)).toBe('too-big');
  });
  it('运行时平台与参数', () => {
    expect(runtimeFor('linux', 'x64')?.archive).toBe('tar.gz');
    expect(runtimeFor('win32', 'x64')?.archive).toBe('zip');
    expect(runtimeFor('freebsd', 'x64')).toBeNull();
    const a = serverArgs({ model: '/m.gguf', port: 1234, ctx: 4096, threads: 4 });
    expect(a).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '--port', '1234', '-t', '4']));
  });
});

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:a1',
  'SUMMARY:周会',
  'DTSTART:20261012T020000Z',
  'DTEND:20261012T030000Z',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'LOCATION:会议室',
  ' A',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:a2',
  'SUMMARY:国庆',
  'DTSTART;VALUE=DATE:20261013',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('ics', () => {
  it('解析 + 折行 + 全天', () => {
    const ev = parseIcs(ICS, 'c');
    expect(ev).toHaveLength(2);
    expect(ev[0].summary).toBe('周会');
    expect(ev[0].location).toBe('会议室A');
    expect(ev[1].allDay).toBe(true);
  });
  it('展开每周重复（COUNT）', () => {
    const ev = parseIcs(ICS, 'c');
    const from = Date.UTC(2026, 9, 1);
    const occ = expand(ev, from, from + 60 * 86_400_000).filter((o) => o.uid === 'a1');
    expect(occ).toHaveLength(3);
    expect(occ[1].start - occ[0].start).toBe(7 * 86_400_000);
  });
  it('往返导出', () => {
    const ev = parseIcs(ICS, 'c');
    const back = parseIcs(toIcs(ev), 'c');
    expect(back.map((e) => e.summary)).toEqual(['周会', '国庆']);
  });
  it('CalDAV 报文', () => {
    expect(caldavQuery(0, 86_400_000)).toContain('calendar-query');
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><c:calendar-data>BEGIN:VCALENDAR&#13;
END:VCALENDAR</c:calendar-data></d:response></d:multistatus>`;
    expect(extractCalendarData(xml)[0]).toContain('BEGIN:VCALENDAR');
  });
});

describe('ics expand: historical occurrences do not use up the safety cap (#34)', () => {
  const DAY = 86_400_000;
  const ev = (rrule: string, start = '20240101T090000Z', extra: string[] = []) =>
    parseIcs(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:r1',
        'SUMMARY:重复',
        `DTSTART:${start}`,
        'DTEND:' + start.replace('T09', 'T10'),
        `RRULE:${rrule}`,
        ...extra,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
      'c',
    );
  const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

  it('infinite DAILY rule started >500 days ago still appears today and in a 31-day window', () => {
    const e = ev('FREQ=DAILY');
    expect(expand(e, day(2026, 10, 19), day(2026, 10, 20))).toHaveLength(1);
    const month = expand(e, day(2026, 10, 1), day(2026, 11, 1));
    expect(month).toHaveLength(31);
    expect(Math.abs(month[0]!.start - Date.UTC(2026, 9, 1, 9))).toBeLessThanOrEqual(3_600_000); // 本地时间展开，夏令时会差 1 小时
  });

  it('finite COUNT that ended before the window yields nothing; one spanning it is counted from the start', () => {
    expect(expand(ev('FREQ=DAILY;COUNT=10'), day(2026, 10, 1), day(2026, 11, 1))).toHaveLength(0);
    // 2024-01-01 起每天，共 1000 次 → 最后一次是 2026-09-26，之后没有
    const e = ev('FREQ=DAILY;COUNT=1000');
    expect(expand(e, day(2026, 6, 19), day(2026, 6, 20))).toHaveLength(1);
    const last = expand(e, day(2026, 9, 1), day(2026, 12, 1));
    expect(Math.abs(last.at(-1)!.start - Date.UTC(2026, 8, 26, 9))).toBeLessThanOrEqual(3_600_000);
    expect(expand(e, day(2026, 9, 27), day(2026, 12, 1))).toHaveLength(0);
  });

  it('INTERVAL keeps its phase after skipping ahead', () => {
    const e = ev('FREQ=DAILY;INTERVAL=3');
    const occ = expand(e, day(2026, 10, 1), day(2026, 11, 1));
    expect(occ.length).toBeGreaterThanOrEqual(10);
    for (const o of occ) expect(Math.round((o.start - Date.UTC(2024, 0, 1, 9)) / DAY) % 3).toBe(0);
    for (let i = 1; i < occ.length; i++) expect(occ[i]!.start - occ[i - 1]!.start).toBe(3 * DAY);
  });

  it('EXDATE removes only that occurrence', () => {
    // 选在与 DTSTART 同一个夏令时区间的日期，保证在任何时区下 EXDATE 与展开值精确一致
    const e = ev('FREQ=DAILY', '20240101T090000Z', ['EXDATE:20260119T090000Z']);
    expect(expand(e, day(2026, 1, 19), day(2026, 1, 20))).toHaveLength(0);
    expect(expand(e, day(2026, 1, 18), day(2026, 1, 19))).toHaveLength(1);
    expect(expand(e, day(2026, 1, 20), day(2026, 1, 21))).toHaveLength(1);
  });

  it('WEEKLY with several BYDAY, MONTHLY and YEARLY from long ago', () => {
    // 2024-01-01 是周一
    const w = ev('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(expand(w, day(2026, 10, 19), day(2026, 11, 2))).toHaveLength(6);
    const m = ev('FREQ=MONTHLY', '20200115T090000Z');
    const mo = expand(m, day(2026, 10, 1), day(2026, 11, 1));
    expect(mo).toHaveLength(1);
    expect(Math.abs(mo[0]!.start - Date.UTC(2026, 9, 15, 9))).toBeLessThanOrEqual(3_600_000);
    const y = ev('FREQ=YEARLY', '20100307T090000Z');
    expect(expand(y, day(2026, 3, 1), day(2026, 4, 1))).toHaveLength(1);
    expect(expand(y, day(2026, 4, 1), day(2027, 3, 1))).toHaveLength(0);
  });

  it('keeps a per-event cap on returned occurrences', () => {
    const e = ev('FREQ=DAILY');
    expect(expand(e, day(2024, 1, 1), day(2030, 1, 1))).toHaveLength(500);
  });

  it('recent short rules still behave as before (weekly COUNT=3 near the start)', () => {
    const e = ev('FREQ=WEEKLY;COUNT=3', '20261005T090000Z');
    expect(expand(e, day(2026, 10, 1), day(2026, 12, 1))).toHaveLength(3);
  });
});

describe('剪贴板过滤', () => {
  it('跳过密钥', () => {
    expect(looksSecret('sk-abcdefghijklmnopqrstuvwx')).toBe(true);
    expect(looksSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(looksSecret('今天下午三点开会')).toBe(false);
  });
});
