/**
 * 网关进程入口把插件的客户端规格组装进内核（P9.5）：用真实的插件 gateway 入口。
 */
import { BUILTIN_GATEWAY_ENTRIES } from '@nomi-ai/cli-plugins/gateways';
import { clientSpecOf, legacyClientOf } from '@nomi-ai/gateway';

import { registerPluginClientSpecs } from '../../../src/gateway/pluginSpecs';

describe('registerPluginClientSpecs', () => {
  it('registers every built-in plugin spec, in legacy identification order', () => {
    expect(registerPluginClientSpecs(BUILTIN_GATEWAY_ENTRIES)).toEqual([
      'claude',
      'codex',
      'grok',
      'dsh',
      'gemini',
    ]);
    for (const e of BUILTIN_GATEWAY_ENTRIES) expect(clientSpecOf(e.client)).toBe(e.clientSpec);
    expect(clientSpecOf('grok')).toMatchObject({ strictness: 'strict', acceptedEvents: 'spec' });
    expect(clientSpecOf('claude')?.heartbeat).toEqual({ kind: 'ping' });
    expect(legacyClientOf('messages', 'x')).toBe('claude');
    expect(legacyClientOf('responses', 'grok-build/1')).toBe('grok');
  });

  it('skips an entry whose spec id does not match its client', () => {
    const bad = { client: 'a', ingress: 'chat', clientSpec: { id: 'b', strictness: 'lenient' } };
    expect(registerPluginClientSpecs([bad as never])).toEqual([]);
    expect(clientSpecOf('b')).toBeUndefined();
  });
});
