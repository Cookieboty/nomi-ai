/**
 * P5-7 集成测试 · 场景 4：tools.confirm(reqId, false) 会 emit 到 插件事件流，
 * 且 setEnabled/register/list 走 ToolRegistry。
 */

import { ToolRegistryKey } from '@nomi-ai/bundle-ig-base';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AIClient } from '../../src/AIClient';
import { createFakeSdkCtx } from '../helpers/fakeSdkCtx';
import { createFakeToolRegistry } from '../helpers/fakeSeams';

function wire() {
  const ctx = createFakeSdkCtx();
  ctx.provide(ToolRegistryKey, createFakeToolRegistry());
  return ctx;
}

describe('AIClient · tools', () => {
  it('register + list + setEnabled + confirm(reqId, false)', async () => {
    const ctx = wire();
    const client = new AIClient(ctx);

    client.tools.register({
      name: 'echo',
      description: '',
      input: z.object({ x: z.string() }),
      dangerous: true,
      async execute(i) {
        return i;
      },
    });

    const list = client.tools.list();
    expect(list.map((t) => t.name)).toEqual(['echo']);
    expect(list[0]!.dangerous).toBe(true);
    expect(list[0]!.enabled).toBe(true);

    client.tools.setEnabled('echo', false);
    expect(client.tools.list()[0]!.enabled).toBe(false);

    client.tools.confirm('r1', false, 'user rejected');
    expect(ctx.emitted).toContainEqual({
      evt: 'tools/wrap',
      payload: { reqId: 'r1', ok: false, reason: 'user rejected' },
    });
    await client.dispose();
  });

  it('setEnabled on unknown tool throws TOOL_NOT_FOUND', async () => {
    const ctx = wire();
    const client = new AIClient(ctx);
    expect(() => client.tools.setEnabled('missing', true)).toThrow(/TOOL_NOT_FOUND/);
    await client.dispose();
  });

  it('confirm without reqId throws TOOL_CONFIRM_INVALID', async () => {
    const ctx = wire();
    const client = new AIClient(ctx);
    expect(() => client.tools.confirm('', true)).toThrow(/TOOL_CONFIRM_INVALID/);
    await client.dispose();
  });
});
