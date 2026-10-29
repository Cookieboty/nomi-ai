#!/usr/bin/env node
/**
 * claudeUsageParser.ts parity 录制（真实源码，esbuild 去类型），TZ=America/New_York。
 * Go 回放：internal/core/usage/claudeparser_parity_test.go（JSON.stringify 逐字节比较）。
 * Usage: node scripts/parity/record-usage-claudeparser.mjs
 */
process.env.TZ = 'America/New_York';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSrc, root } from './usage-src.mjs';

const { parseClaudeResetTime, parseClaudeUsageResult } = (await loadSrc('usage/claudeUsageParser', {})).mod;

const nows = [Date.UTC(2026, 9, 29, 11, 0), Date.UTC(2026, 2, 8, 6, 30), Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 11, 31, 23, 0), Date.UTC(2026, 1, 28, 12, 0), Date.UTC(2027, 0, 1, 5, 30)];
const spans = [5, 168];
const inputs = [
  '3pm (Asia/Shanghai)', '3pm', '  11:30am  ', '12am (UTC)', '12pm (Europe/London)', '1:05 PM (America/New_York)', '13pm', '0am', '3:60pm', '3:5pm',
  'Oct 20, 3pm (Asia/Shanghai)', 'Oct 20 at 3:30pm', 'October 31, 11pm (Australia/Sydney)', 'Nov 1, 1:30am (America/New_York)', 'Mar 8, 2:30am (America/New_York)',
  'Feb 29, 9am', 'Feb 30, 9am', 'Jan 1, 2027, 9am', 'Jan 1, 2025, 9am (Asia/Tokyo)', 'Dec 31, 11pm', 'Xyz 3, 3pm', 'Oct 0, 3pm', 'Oct 20,3pm', 'Oct 20 3pm',
  '3pm (Not/AZone)', '3pm ()', '3pm (asia/shanghai)', '3\u00a0pm', 'Oct\u00a020, 3pm', 'at 3pm', 'resets soon', '', '3pm (Asia/Kolkata', 'Oct 20, 0099, 3pm',
  '3pmx', 'x3pm', '123pm', 'Octember 20, 3pm', 'oct 20, 3PM', '3ſm', 'Nov 1, 2026, 1:30am (America/New_York)', 'Jan 1, 1970, 12am (UTC)', '3pm (utc)', '3pm (etc/gmt+5)', '3pm (america/port-au-prince)', '3pm (europe/isle_of_man)', '3pm (america/argentina/buenos_aires)', '3pm (AMERICA/NEW_YORK)', '3pm (Asia/Calcutta)',
];
const reset = [];
for (const now of nows) for (const span of spans) for (const s of inputs) reset.push({ s, now, span, r: parseClaudeResetTime(s, now, span) });
reset.push({ s: '3pm', now: NaN, span: 5, r: parseClaudeResetTime('3pm', NaN, 5) });

const env = (result, o = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, local_command: 'usage', num_turns: 0, ...o });
const body = 'Current session: 12% used · resets 3pm (Asia/Shanghai)\nCurrent week (all models): 40% used · resets Oct 20, 3pm (Asia/Shanghai)\n';
const outputs = [
  env(body), env(body.replace('12%', '12.5%')), env('Current session: 150% used\ncurrent week: 3%\nCurrent Week (All Models): 9% used · resets Nov 3, 9am'),
  env('\u001b[1mCurrent session\u001b[0m: 5% used · resets 4pm\nCurrent session: 99% used'), env('Current session: lots used'), env('Current session 5%'),
  env('Current session: 5% used · something · RESETS 6pm'), env('Current session: 5% used · resets\u00a0 6pm'), env('Current session: 5% used · reset 6pm'),
  env('Current session: 5%   used'), env('Current session: 5%used'), env('Current session: 5% USED'), env('Current session: 0% used · resets nope'),
  env(body, { is_error: true }), env(body, { local_command: undefined, num_turns: 2 }), env(body, { local_command: 'other', num_turns: 0 }), env(body, { local_command: 'x', num_turns: '3' }),
  env('Unknown skill: usage'), env('Error 401 from server'), env('Error 4013'), env('Please run /login'), env('Unauthorized but Unknown command'),
  JSON.stringify([{ type: 'system' }, { type: 'result', result: body, local_command: 'usage' }, { type: 'assistant' }]),
  JSON.stringify([{ type: 'result', result: 'Current week: 7%' }, { type: 'result', result: body }]), JSON.stringify([{ type: 'system' }]), JSON.stringify([null, [1]]),
  'not json: 403 forbidden', '\u001b[1m401\u001b[0m', env('Current session: 5% used · resets Jan 1, 1970, 12am (UTC)'), '\u001b[31mnot logged in\u001b[0m', 'garbage', '', 'null', '5', '{"result":5}', '{"result":"Current session: 1%"}',
  env('Current session: 5% used · resets 3pm\r\nCurrent week: 6% used · resets Oct 20, 3pm\r'),
];
const parsed = outputs.map((o) => JSON.stringify(parseClaudeUsageResult(o, nows[0])));

writeFileSync(join(root, 'apps/desktop-go/internal/core/usage/testdata/usage-claudeparser.json'), JSON.stringify({ tz: process.env.TZ, reset, outputs, parsed }, null, 1) + '\n');
console.log(`usage-claudeparser: ${reset.length} reset cases, ${outputs.length} outputs`);
