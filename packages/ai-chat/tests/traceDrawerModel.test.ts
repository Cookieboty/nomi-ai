/** 执行轨迹抽屉的数据整理：时间窗、瀑布图的行与位置 */
import { describe, expect, it } from 'vitest';

import {
  FALLBACK_WINDOW_MS,
  barOf,
  offsetLabel,
  prettyJson,
  turnWindow,
  waterfallRows,
  waterfallSpan,
} from '../src/components/TraceDrawer/model';
import type { QualityRequestItem } from '../src/services/qualityClient';

const T0 = 1_800_000_000_000;

describe('turnWindow', () => {
  it('结束 = 消息时间，开始取耗时与最早事件中较早的', () => {
    expect(turnWindow({ at: T0 + 10_000, durationMs: 8000 })).toEqual({
      from: T0 + 2000,
      to: T0 + 10_000,
    });
    expect(
      turnWindow({
        at: T0 + 10_000,
        durationMs: 5000,
        trace: [{ type: 'tool', name: 'Read', status: 'start', detail: 'c1', at: T0 + 1000 }],
      }),
    ).toEqual({ from: T0 + 1000, to: T0 + 10_000 });
  });

  it('没有耗时也没有时间戳时往前看一段', () => {
    expect(turnWindow({ at: T0 })).toEqual({ from: T0 - FALLBACK_WINDOW_MS, to: T0 });
  });
});

describe('waterfallRows', () => {
  const req = {
    id: 'q1',
    layer: 'gateway',
    ts: T0 + 500,
    client: 'claude',
    source: 'thirdParty',
    stream: true,
    outcome: 'ok',
    timing: { endMs: 2000, firstContentMs: 300 },
    tokens: {},
  } as QualityRequestItem;

  it('工具调用按 id 配对，子调用缩进，和网关请求一起按开始时间排', () => {
    const rows = waterfallRows(
      {
        trace: [
          { type: 'tool', name: 'Task', status: 'start', detail: 'p', at: T0 + 1000 },
          {
            type: 'tool',
            name: 'Read',
            status: 'start',
            detail: 'c',
            parentId: 'p',
            at: T0 + 1200,
          },
          { type: 'tool', name: 'Read', status: 'done', detail: 'c', at: T0 + 1500 },
          {
            type: 'tool',
            name: 'Task',
            status: 'error',
            detail: 'p',
            output: 'boom',
            at: T0 + 3000,
          },
        ],
      },
      [req],
    );
    expect(rows.map((r) => r.kind)).toEqual(['request', 'tool', 'tool']);
    const [r0, task, read] = rows;
    expect(r0).toMatchObject({ start: T0 + 500, end: T0 + 2500, firstAt: T0 + 800 });
    expect(task).toMatchObject({ kind: 'tool', depth: 0, end: T0 + 3000 });
    expect(task?.kind === 'tool' && task.call.status).toBe('error');
    expect(read).toMatchObject({ kind: 'tool', depth: 1, start: T0 + 1200, end: T0 + 1500 });
  });

  it('刻度覆盖所有行；条的位置按比例', () => {
    const rows = waterfallRows({}, [req]);
    const span = waterfallSpan({ from: T0 + 1000, to: T0 + 2000 }, rows);
    expect(span).toEqual({ from: T0 + 500, to: T0 + 2500 });
    expect(barOf(rows[0]!, span)).toEqual({ left: 0, width: 100 });
  });
});

describe('格式化', () => {
  it('相对时间与 JSON 美化', () => {
    expect(offsetLabel(T0 + 1234, T0)).toBe('+1.23s');
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('not json')).toBe('not json');
  });
});
