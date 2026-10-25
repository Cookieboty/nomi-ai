import { t as tr } from '../i18n';
/**
 * 最小 iCalendar（RFC 5545）解析 / 生成：VEVENT 的 UID、SUMMARY、DTSTART/DTEND（含 VALUE=DATE、
 * UTC「Z」、TZID 视为本地时间）、LOCATION、DESCRIPTION、RRULE（FREQ=DAILY/WEEKLY/MONTHLY/YEARLY，
 * INTERVAL、COUNT、UNTIL、BYDAY）、EXDATE。自研实现，无第三方依赖。
 */
export interface CalEvent {
  uid: string;
  summary: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  description?: string;
  rrule?: string;
  exdates?: number[];
  /** 来源日历 id */
  cal: string;
}

export interface Occurrence {
  uid: string;
  summary: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  cal: string;
}

/** 展开折行（以空格 / Tab 开头的行接到上一行） */
export function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

const unescape = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const escape = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/([,;])/g, '\\$1');

export function parseDate(value: string, params: string): { t: number; allDay: boolean } {
  const v = value.trim();
  const allDay = /VALUE=DATE(?!-)/i.test(params) || /^\d{8}$/.test(v);
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return { t: NaN, allDay };
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
  const t = z
    ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
    : new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return { t, allDay };
}

export function parseIcs(text: string, cal: string): CalEvent[] {
  const out: CalEvent[] = [];
  let cur: Partial<CalEvent> | null = null;
  let durMs = 0;
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT/i.test(line)) {
      cur = { cal, exdates: [] };
      durMs = 0;
      continue;
    }
    if (/^END:VEVENT/i.test(line)) {
      if (cur && cur.start !== undefined && !Number.isNaN(cur.start)) {
        const end = cur.end ?? cur.start + (durMs || (cur.allDay ? 86_400_000 : 3_600_000));
        out.push({
          uid: cur.uid || `${cal}-${cur.start}-${out.length}`,
          summary: cur.summary || tr('electron.common.untitled-d8f9b1'),
          start: cur.start,
          end,
          allDay: !!cur.allDay,
          location: cur.location,
          description: cur.description,
          rrule: cur.rrule,
          exdates: cur.exdates?.length ? cur.exdates : undefined,
          cal,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...ps] = line.slice(0, i).split(';');
    const params = ps.join(';');
    const value = line.slice(i + 1);
    switch (name.toUpperCase()) {
      case 'UID':
        cur.uid = value.trim();
        break;
      case 'SUMMARY':
        cur.summary = unescape(value).slice(0, 300);
        break;
      case 'LOCATION':
        cur.location = unescape(value).slice(0, 300);
        break;
      case 'DESCRIPTION':
        cur.description = unescape(value).slice(0, 2000);
        break;
      case 'DTSTART': {
        const d = parseDate(value, params);
        cur.start = d.t;
        cur.allDay = d.allDay;
        break;
      }
      case 'DTEND':
        cur.end = parseDate(value, params).t;
        break;
      case 'DURATION':
        durMs = parseDuration(value);
        break;
      case 'RRULE':
        cur.rrule = value.trim();
        break;
      case 'EXDATE':
        for (const v of value.split(',')) {
          const t = parseDate(v, params).t;
          if (!Number.isNaN(t)) cur.exdates!.push(t);
        }
        break;
    }
  }
  return out;
}

export function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    v.trim(),
  );
  if (!m) return 0;
  const [, , w = '0', d = '0', h = '0', mi = '0', s = '0'] = m;
  return ((+w * 7 + +d) * 86400 + +h * 3600 + +mi * 60 + +s) * 1000;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** 单个重复事件在窗口内最多返回的发生次数 */
const MAX_OCCURRENCES_PER_EVENT = 500;
/** 单个重复事件最多迭代的周期数（防止超老 / 高频规则造成长时间阻塞） */
const MAX_PERIODS = 20_000;
const DAY_MS = 86_400_000;

/**
 * 无 COUNT 的规则不需要知道「第几次发生」，可以把周期起点直接推进到查询窗附近
 * （留 1 个周期余量覆盖夏令时 / 跨窗发生）；有 COUNT 必须从头数，不跳。
 */
function startPeriod(freq: string, interval: number, base: Date, target: number): number {
  const t = new Date(target);
  let periods = 0;
  if (freq === 'DAILY') periods = Math.floor((target - base.getTime()) / (DAY_MS * interval));
  else if (freq === 'WEEKLY')
    periods = Math.floor((target - base.getTime()) / (7 * DAY_MS * interval));
  else if (freq === 'MONTHLY')
    periods = Math.floor(
      (t.getFullYear() * 12 + t.getMonth() - (base.getFullYear() * 12 + base.getMonth())) /
        interval,
    );
  else if (freq === 'YEARLY')
    periods = Math.floor((t.getFullYear() - base.getFullYear()) / interval);
  return Math.max(0, periods - 1);
}

/** 把事件展开到 [from, to) 内的具体发生（每个重复事件最多返回 500 次；历史发生次数不占用该上限） */
export function expand(events: CalEvent[], from: number, to: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (const e of events) {
    const dur = e.end - e.start;
    const push = (s: number) => {
      if (s + dur > from && s < to && !e.exdates?.includes(s))
        out.push({
          uid: e.uid,
          summary: e.summary,
          start: s,
          end: s + dur,
          allDay: e.allDay,
          location: e.location,
          cal: e.cal,
        });
    };
    if (!e.rrule) {
      push(e.start);
      continue;
    }
    const r: Record<string, string> = {};
    for (const kv of e.rrule.split(';')) {
      const [k, v] = kv.split('=');
      if (k && v) r[k.toUpperCase()] = v;
    }
    const freq = r.FREQ;
    const interval = Math.max(1, Number(r.INTERVAL) || 1);
    const count = r.COUNT ? Number(r.COUNT) : Infinity;
    const until = r.UNTIL ? parseDate(r.UNTIL, '').t : Infinity;
    const byday = r.BYDAY
      ? r.BYDAY.split(',')
          .map((d) => DAYS.indexOf(d.slice(-2)))
          .filter((d) => d >= 0)
      : [];
    const base = new Date(e.start);
    let n = 0;
    let emitted = 0;
    const k0 = count === Infinity ? startPeriod(freq ?? '', interval, base, from - dur) : 0;
    for (
      let k = k0;
      k < k0 + MAX_PERIODS && n < count && emitted < MAX_OCCURRENCES_PER_EVENT;
      k++
    ) {
      const cands: Date[] = [];
      const d = new Date(base);
      if (freq === 'DAILY') d.setDate(base.getDate() + k * interval);
      else if (freq === 'WEEKLY') d.setDate(base.getDate() + k * 7 * interval);
      else if (freq === 'MONTHLY') d.setMonth(base.getMonth() + k * interval);
      else if (freq === 'YEARLY') d.setFullYear(base.getFullYear() + k * interval);
      else break;
      if (freq === 'WEEKLY' && byday.length) {
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        for (const wd of byday.sort()) {
          const x = new Date(weekStart);
          x.setDate(weekStart.getDate() + wd);
          if (x.getTime() >= e.start) cands.push(x);
        }
      } else cands.push(d);
      let stop = false;
      for (const c of cands) {
        const t = c.getTime();
        if (t > until || n >= count) {
          stop = true;
          break;
        }
        n++;
        if (t >= to) {
          stop = true;
          break;
        }
        const before = out.length;
        push(t);
        if (out.length > before) emitted++;
      }
      if (stop) break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const fmtUtc = (t: number) =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const fmtDate = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

export function toIcs(events: CalEvent[], name = 'Nomi'): string {
  const L = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nomi//Local Calendar//ZH',
    `X-WR-CALNAME:${escape(name)}`,
  ];
  for (const e of events) {
    L.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${fmtUtc(Date.now())}`);
    if (e.allDay)
      L.push(`DTSTART;VALUE=DATE:${fmtDate(e.start)}`, `DTEND;VALUE=DATE:${fmtDate(e.end)}`);
    else L.push(`DTSTART:${fmtUtc(e.start)}`, `DTEND:${fmtUtc(e.end)}`);
    L.push(`SUMMARY:${escape(e.summary)}`);
    if (e.location) L.push(`LOCATION:${escape(e.location)}`);
    if (e.description) L.push(`DESCRIPTION:${escape(e.description)}`);
    if (e.rrule) L.push(`RRULE:${e.rrule}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}

/** CalDAV REPORT calendar-query 请求体（时间范围） */
export function caldavQuery(from: number, to: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${fmtUtc(from)}" end="${fmtUtc(to)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
}

/** 从 multistatus XML 里取出所有 calendar-data（CDATA 或转义文本） */
export function extractCalendarData(xml: string): string[] {
  const out: string[] = [];
  const re = /<(?:[\w-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    let s = m[1].trim();
    const cd = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(s);
    s = cd
      ? cd[1]
      : s
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#13;/g, '')
          .replace(/&amp;/g, '&');
    out.push(s);
  }
  return out;
}
