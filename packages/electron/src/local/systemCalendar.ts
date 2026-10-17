/**
 * 系统日历（只在用户在「设置 → 日程与日历 → 日历接入」里点了「连接系统日历」后才会调用）：
 *
 * - macOS：osascript（JXA）脚本化「日历」App。首次调用时系统弹出「Nomi 想要控制“日历”」
 *   自动化授权；拒绝后可在 系统设置 → 隐私与安全性 → 自动化 里重新打开。
 *   限制：AppleScript 的 whose 查询不展开重复日程（只返回落在区间内的那一次 / 主事件），
 *   日历很多时较慢（这里只取 -1 天 ~ +30 天）。EventKit 原生 helper 需要签名的二进制，暂未提供。
 * - Windows：没有不打包（MSIX）也能用的系统日历 API（AppointmentStore 需要包身份 +
 *   appointments 能力）。这里尝试「经典版 Outlook」的 COM 接口（新版 Outlook 不支持 COM）；
 *   其余情况请用 ICS 订阅 / CalDAV（Google、iCloud、Outlook.com 都提供）。
 * - Linux：读取 Evolution / GNOME 日历的本地日历文件
 *   ~/.local/share/evolution/calendar/<id>/calendar.ics；在线账户（Google 等）请用 CalDAV。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { t as tr } from '../i18n';

import { parseIcs, type CalEvent } from './ics';

export type SystemProvider = 'macos-calendar' | 'outlook-com' | 'evolution';

export interface SystemCalendarInfo {
  provider: SystemProvider | null;
  canCreate: boolean;
}

export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultRunner: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (e, so, se) => (e ? reject(new Error(String(se || e.message).trim())) : resolve(String(so))),
    );
  });

export function systemCalendarInfo(
  platform: NodeJS.Platform = process.platform,
): SystemCalendarInfo {
  if (platform === 'darwin') return { provider: 'macos-calendar', canCreate: true };
  if (platform === 'win32') return { provider: 'outlook-com', canCreate: true };
  if (platform === 'linux') return { provider: 'evolution', canCreate: false };
  return { provider: null, canCreate: false };
}

/** JXA：批量取属性（一次 Apple Event 拿一整列），比逐个事件访问快一个数量级 */
export function jxaReadScript(from: number, to: number): string {
  return `
const Cal = Application('Calendar');
const from = new Date(${Math.floor(from)}), to = new Date(${Math.floor(to)});
const out = [];
for (const c of Cal.calendars()) {
  let name = ''; try { name = c.name(); } catch (e) {}
  const sp = c.events.whose({ _and: [ { startDate: { _lessThan: to } }, { endDate: { _greaterThan: from } } ] });
  let uids = []; try { uids = sp.uid(); } catch (e) { continue; }
  if (!uids.length) continue;
  const sum = sp.summary(), st = sp.startDate(), en = sp.endDate(), ad = sp.alldayEvent();
  let loc = []; try { loc = sp.location(); } catch (e) {}
  for (let i = 0; i < uids.length; i++)
    out.push({ uid: uids[i], summary: sum[i] || '', start: +st[i], end: +en[i], allDay: !!ad[i],
      location: loc[i] || '', calendar: name });
}
JSON.stringify(out);
`;
}

export function jxaCreateScript(e: {
  summary: string;
  start: number;
  end: number;
  calendar?: string;
}) {
  const p = JSON.stringify(e);
  return `
const Cal = Application('Calendar');
const e = ${p};
const cals = Cal.calendars().filter((c) => { try { return c.writable(); } catch (x) { return true; } });
const target = (e.calendar && cals.find((c) => c.name() === e.calendar)) || cals[0];
if (!target) throw new Error('no writable calendar');
const ev = Cal.Event({ summary: e.summary, startDate: new Date(e.start), endDate: new Date(e.end) });
target.events.push(ev);
JSON.stringify({ ok: true, calendar: target.name() });
`;
}

/** PowerShell + Outlook COM（经典版 Outlook）。输出 JSON 数组。 */
export function outlookReadScript(from: number, to: number): string {
  const f = new Date(from).toISOString();
  const t = new Date(to).toISOString();
  return `
$ErrorActionPreference = 'Stop'
$o = New-Object -ComObject Outlook.Application
$ns = $o.GetNamespace('MAPI')
$cal = $ns.GetDefaultFolder(9)
$items = $cal.Items
$items.IncludeRecurrences = $true
$items.Sort('[Start]')
$from = [datetime]::Parse('${f}').ToLocalTime().ToString('g')
$to = [datetime]::Parse('${t}').ToLocalTime().ToString('g')
$r = $items.Restrict("[Start] < '$to' AND [End] > '$from'")
$out = @()
foreach ($i in $r) {
  if ($out.Count -ge 500) { break }
  $out += [pscustomobject]@{ uid = $i.GlobalAppointmentID + '-' + $i.Start.ToString('o'); summary = $i.Subject;
    start = [int64](($i.Start.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds);
    end = [int64](($i.End.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds);
    allDay = [bool]$i.AllDayEvent; location = $i.Location; calendar = 'Outlook' }
}
ConvertTo-Json -InputObject @($out) -Compress
`;
}

export function outlookCreateScript(e: { summary: string; start: number; end: number }): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$o = New-Object -ComObject Outlook.Application
$a = $o.CreateItem(1)
$a.Subject = '${esc(e.summary)}'
$a.Start = [datetime]::Parse('${new Date(e.start).toISOString()}').ToLocalTime()
$a.End = [datetime]::Parse('${new Date(e.end).toISOString()}').ToLocalTime()
$a.ReminderSet = $true
$a.Save()
'{"ok":true,"calendar":"Outlook"}'
`;
}

interface RawEvent {
  uid: string;
  summary: string;
  start: number;
  end: number;
  allDay?: boolean;
  location?: string;
  calendar?: string;
}

export function toCalEvents(raw: unknown, cal: string): CalEvent[] {
  const arr = Array.isArray(raw) ? (raw as RawEvent[]) : raw ? [raw as RawEvent] : [];
  return arr
    .filter((e) => e && Number.isFinite(e.start) && Number.isFinite(e.end) && e.uid)
    .map((e) => ({
      uid: `${cal}:${String(e.uid)}`,
      summary: String(e.summary ?? '').slice(0, 200) || tr('（无标题）'),
      start: Number(e.start),
      end: Math.max(Number(e.end), Number(e.start)),
      allDay: !!e.allDay,
      location: e.location ? String(e.location).slice(0, 200) : undefined,
      description: e.calendar ? String(e.calendar) : undefined,
      cal,
    }));
}

export function evolutionFiles(home = os.homedir()): string[] {
  const root = path.join(home, '.local', 'share', 'evolution', 'calendar');
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name, 'calendar.ics'))
      .filter((p) => fs.existsSync(p));
  } catch {
    return [];
  }
}

export async function readSystemCalendar(opts: {
  platform?: NodeJS.Platform;
  from: number;
  to: number;
  cal: string;
  run?: Runner;
  home?: string;
}): Promise<CalEvent[]> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRunner;
  const info = systemCalendarInfo(platform);
  if (info.provider === 'macos-calendar') {
    const so = await run(
      'osascript',
      ['-l', 'JavaScript', '-e', jxaReadScript(opts.from, opts.to)],
      60_000,
    );
    return toCalEvents(JSON.parse(so.trim() || '[]'), opts.cal);
  }
  if (info.provider === 'outlook-com') {
    const so = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', outlookReadScript(opts.from, opts.to)],
      60_000,
    );
    return toCalEvents(JSON.parse(so.trim() || '[]'), opts.cal);
  }
  if (info.provider === 'evolution') {
    const files = evolutionFiles(opts.home);
    if (!files.length) throw new Error('evolution: no local calendar');
    return files.flatMap((f) => parseIcs(fs.readFileSync(f, 'utf8'), opts.cal));
  }
  throw new Error('unsupported platform');
}

export async function createSystemEvent(opts: {
  platform?: NodeJS.Platform;
  summary: string;
  start: number;
  end: number;
  run?: Runner;
}): Promise<{ ok: boolean; calendar?: string }> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRunner;
  const e = { summary: opts.summary.slice(0, 200), start: opts.start, end: opts.end };
  let so: string;
  if (platform === 'darwin')
    so = await run('osascript', ['-l', 'JavaScript', '-e', jxaCreateScript(e)], 30_000);
  else if (platform === 'win32')
    so = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', outlookCreateScript(e)],
      30_000,
    );
  else throw new Error('create not supported');
  return JSON.parse(so.trim()) as { ok: boolean; calendar?: string };
}
