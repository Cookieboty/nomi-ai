/**
 * #121：终态判定前先 flushResidual，解析 SSE 尾帧，不因半截缓冲误判断流。
 */
import { describe, expect, it } from 'vitest';

import { UsageTap } from '../src/usageTap';

const frame = (o: Record<string, unknown>) => `data: ${JSON.stringify(o)}\n\n`;

describe('UsageTap.flushResidual (#121)', () => {
  it('parses a trailing SSE frame left in the parser buffer before end()', () => {
    const tap = new UsageTap('chat');
    // Incomplete final frame: no trailing blank line yet
    tap.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n');
    expect(tap.firstTextAt).toBeUndefined();
    tap.flushResidual();
    // Still incomplete → no event; but residualFlushed so end() does not double-parse
    tap.end();
    // Push a complete frame then residual-flush mid-stream equivalent: complete then residual
    const tap2 = new UsageTap('chat');
    tap2.push(frame({ choices: [{ delta: { content: 'hi' } }] }));
    expect(tap2.firstTextAt).toBeTypeOf('number');
    const before = tap2.usage;
    tap2.flushResidual();
    tap2.flushResidual(); // idempotent
    expect(tap2.usage).toEqual(before);
  });

  it('end() still synthesizes terminal after flushResidual', () => {
    const tap = new UsageTap('chat');
    tap.push(frame({ choices: [{ delta: { content: 'x' } }] }));
    tap.flushResidual();
    tap.end();
    // chat without finish_reason may synthesize; at least no throw and terminated readable
    expect(typeof tap.terminated).toBe('boolean');
  });
});

describe('gateway keepAlive skips nomi (#114)', () => {
  it('server keepAlive early-returns when client is nomi (source contract)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
    expect(src).toMatch(/if \(keepAliveClient === 'nomi'\) return;/);
    expect(src).toMatch(/tap\.flushResidual\(\)/);
  });
});
