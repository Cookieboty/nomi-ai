import { parseClaudeResetTime, parseClaudeUsageResult } from '../../../src/usage/claudeUsageParser';

const env = (result: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    is_error: false,
    local_command: 'usage',
    num_turns: 0,
    result,
    ...extra,
  });

const T = (iso: string) => Date.parse(iso);

describe('parseClaudeResetTime：自然语言重置时间（含时区 / 夏令时）', () => {
  it('只有钟点：取接下来最近的那次（带 IANA 时区）', () => {
    // 2026-10-16 02:00Z = 上海 10:00；「3pm (Asia/Shanghai)」= 当天 15:00 +08 = 07:00Z
    const now = T('2026-10-16T02:00:00Z');
    expect(parseClaudeResetTime('3pm (Asia/Shanghai)', now, 5)).toBe(T('2026-10-16T07:00:00Z'));
    // 已过 3pm：重置时间已经过去，取刚过去的那次（面板会把该窗口标为「已重置」）
    expect(parseClaudeResetTime('3pm (Asia/Shanghai)', T('2026-10-16T08:00:00Z'), 5)).toBe(
      T('2026-10-16T07:00:00Z'),
    );
  });

  it('带日期：Oct 20, 3pm / Oct 20 at 3:30pm', () => {
    const now = T('2026-10-16T02:00:00Z');
    expect(parseClaudeResetTime('Oct 20, 3pm (Asia/Shanghai)', now, 168)).toBe(
      T('2026-10-20T07:00:00Z'),
    );
    expect(parseClaudeResetTime('Oct 20 at 3:30pm (UTC)', now, 168)).toBe(
      T('2026-10-20T15:30:00Z'),
    );
    expect(parseClaudeResetTime('October 20, 12am (UTC)', now, 168)).toBe(
      T('2026-10-20T00:00:00Z'),
    );
  });

  it('夏令时：美东 11 月 1 日回拨日，按当时的偏移换算', () => {
    // 2026-11-01 美东 01:30 出现两次（EDT 05:30Z 与 EST 06:30Z）；取「接下来最近」的那个
    const now = T('2026-11-01T04:00:00Z');
    expect(parseClaudeResetTime('1:30am (America/New_York)', now, 5)).toBe(
      T('2026-11-01T05:30:00Z'),
    );
    // 3 月 8 日前进日：2:30am 不存在 → 取不到（不猜）
    expect(
      parseClaudeResetTime('Mar 8, 2:30am (America/New_York)', T('2026-03-07T12:00:00Z'), 168),
    ).toBeNull();
    // 夏令时前后同一钟点的 UTC 差一小时
    const a = parseClaudeResetTime(
      'Mar 7, 9am (America/New_York)',
      T('2026-03-07T00:00:00Z'),
      168,
    )!;
    const b = parseClaudeResetTime(
      'Mar 9, 9am (America/New_York)',
      T('2026-03-07T00:00:00Z'),
      168,
    )!;
    expect(a).toBe(T('2026-03-07T14:00:00Z'));
    expect(b).toBe(T('2026-03-09T13:00:00Z'));
  });

  it('不认识的时区回落系统时区；坏格式返回 null', () => {
    const now = T('2026-10-16T02:00:00Z');
    expect(parseClaudeResetTime('3pm (Not/AZone)', now, 5)).not.toBeNull();
    expect(parseClaudeResetTime('soon', now, 5)).toBeNull();
    expect(parseClaudeResetTime('13pm (UTC)', now, 5)).toBeNull();
    expect(parseClaudeResetTime('Foo 20, 3pm (UTC)', now, 5)).toBeNull();
    expect(parseClaudeResetTime('3pm', Number.NaN, 5)).toBeNull();
  });
});

describe('parseClaudeUsageResult', () => {
  const now = T('2026-10-16T02:00:00Z');

  it('订阅账号：Current session / Current week (all models) → five_hour / seven_day', () => {
    const r = parseClaudeUsageResult(
      env(
        [
          'Total cost:            $0.0000',
          'Current session: 12% used · resets 3pm (Asia/Shanghai)',
          'Current week (all models): 40.5% used · resets Oct 20, 3pm (Asia/Shanghai)',
          'Current week (Opus): 90% used · resets Oct 20, 3pm (Asia/Shanghai)',
        ].join('\n'),
      ),
      now,
    );
    expect(r.denied).toBe(false);
    expect(r.unsupported).toBe(false);
    expect(r.windows).toEqual([
      { id: 'five_hour', usedPercent: 12, windowMinutes: 300, resetAt: T('2026-10-16T07:00:00Z') },
      {
        id: 'seven_day',
        usedPercent: 40.5,
        windowMinutes: 10080,
        resetAt: T('2026-10-20T07:00:00Z'),
      },
    ]);
  });

  it('容忍 ANSI 颜色、数组形式的流式输出、百分比越界；没有重置时间也能出窗口', () => {
    const text = '\u001b[1mCurrent session\u001b[0m: 150% used';
    const j = JSON.stringify([
      { type: 'system' },
      { type: 'result', result: text, local_command: 'usage', num_turns: 0 },
    ]);
    // ANSI 控制符先剥掉再解析；百分比封顶 100
    expect(parseClaudeUsageResult(j, now).windows).toEqual([
      { id: 'five_hour', usedPercent: 100, windowMinutes: 300 },
    ]);
    const j2 = JSON.stringify([
      {
        type: 'result',
        result: 'Current session: 150% used',
        local_command: 'usage',
        num_turns: 0,
      },
    ]);
    expect(parseClaudeUsageResult(j2, now).windows).toEqual([
      { id: 'five_hour', usedPercent: 100, windowMinutes: 300 },
    ]);
  });

  it('本机实测（未登录 / API 账号）：只有费用统计、没有额度行 → 无窗口，不算错误也不算不支持', () => {
    const real = env(
      'Total cost:            $0.0000\nTotal duration (API):  0s\nTotal duration (wall): 0s\nTotal code changes:    0 lines added, 0 lines removed\nUsage:                 0 input, 0 output, 0 cache read, 0 cache write',
    );
    const r = parseClaudeUsageResult(real, now);
    expect(r).toEqual({ windows: [], denied: false, isError: false, unsupported: false });
  });

  it('不支持：Unknown skill / 被当作普通提示（没有 local_command 且有对话轮次）', () => {
    expect(parseClaudeUsageResult(env('Unknown skill: usage'), now).unsupported).toBe(true);
    const asPrompt = JSON.stringify({ type: 'result', result: 'Sure! Here is…', num_turns: 1 });
    expect(parseClaudeUsageResult(asPrompt, now).unsupported).toBe(true);
  });

  it('认证类：401 / not logged in / 登录过期 → denied（与暂时性失败区分）', () => {
    expect(parseClaudeUsageResult(env('Error: 401 Unauthorized'), now).denied).toBe(true);
    expect(parseClaudeUsageResult(env('Not logged in · Please run /login'), now).denied).toBe(true);
    expect(parseClaudeUsageResult('Authentication failed (not json)', now).denied).toBe(true);
    // 数字里出现 401 不算（词边界）；额度用尽也不是认证失败
    expect(parseClaudeUsageResult(env('cost $14010.00'), now).denied).toBe(false);
    expect(parseClaudeUsageResult(env("You've hit your limit"), now).denied).toBe(false);
  });

  it('坏输出：非 JSON / 没有 result / is_error', () => {
    expect(parseClaudeUsageResult('boom', now).isError).toBe(true);
    expect(parseClaudeUsageResult('{"type":"result"}', now).isError).toBe(true);
    expect(parseClaudeUsageResult('null', now).isError).toBe(true);
    expect(parseClaudeUsageResult(env('x', { is_error: true }), now).isError).toBe(true);
  });
});
