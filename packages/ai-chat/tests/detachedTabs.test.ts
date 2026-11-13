import { describe, expect, it } from 'vitest';

import {
  canDetachTarget,
  DETACH_QUERY,
  detachedId,
  detachedKeysFor,
  detachSpecKey,
  parseDetachedId,
  parseDetachSpec,
  type DetachSpec,
} from '../src/utils/detachedTabs';
import { fileTabKey } from '../src/utils/sideTabs';

const q = (spec: unknown) => `?${new URLSearchParams({ [DETACH_QUERY]: JSON.stringify(spec) })}`;

describe('detached tab windows: routing', () => {
  it('ids round-trip and select the tabs of one conversation', () => {
    const id = detachedId('nomi:c1', 'harness:t1');
    expect(parseDetachedId(id)).toEqual({ scope: 'nomi:c1', key: 'harness:t1' });
    expect(parseDetachedId('garbage')).toBeNull();
    expect(parseDetachedId('["only-one"]')).toBeNull();
    const ids = [id, detachedId('nomi:c2', 'harness:t2'), detachedId('nomi:c1', fileTabKey('k'))];
    expect([...detachedKeysFor(ids, 'nomi:c1')]).toEqual(['harness:t1', fileTabKey('k')]);
    expect(detachedKeysFor(ids, 'nomi:zz').size).toBe(0);
  });

  it('agent specs from the page URL select that agent tab', () => {
    const harness: DetachSpec = {
      v: 1,
      kind: 'agent',
      scope: 'nomi:c1',
      target: { kind: 'harness', tabId: 't1' },
      title: 'Claude Code',
    };
    expect(parseDetachSpec(q(harness))).toEqual(harness);
    expect(detachSpecKey(harness)).toBe('harness:t1');
    const task = { ...harness, target: { kind: 'nomi-task', taskId: 'k1' } };
    expect(detachSpecKey(parseDetachSpec(q(task))!)).toBe('nomi-task:k1');
    const nested = { ...harness, target: { kind: 'nested', callId: 'c9', parentTabId: 'p1' } };
    expect(detachSpecKey(parseDetachSpec(q(nested))!)).toBe('nested:c9');
  });

  it('file specs carry the preview scope', () => {
    const file: DetachSpec = {
      v: 1,
      kind: 'file',
      scope: 'nomi:c1',
      key: fileTabKey('e1'),
      href: '/w/README.md',
      origin: { id: 'nomi:c1', cwd: '/w', source: 'nomi' },
      title: 'README.md',
    };
    expect(parseDetachSpec(q(file))).toEqual(file);
    expect(detachSpecKey(file)).toBe(fileTabKey('e1'));
  });

  it('not a detached window / malformed specs → main window', () => {
    expect(parseDetachSpec('')).toBeNull();
    expect(parseDetachSpec('?other=1')).toBeNull();
    expect(parseDetachSpec(`?${DETACH_QUERY}=%7Bnope`)).toBeNull();
    expect(
      parseDetachSpec(
        q({ v: 2, kind: 'agent', scope: 's', target: { kind: 'harness', tabId: 't' } }),
      ),
    ).toBeNull();
    expect(
      parseDetachSpec(q({ v: 1, kind: 'agent', scope: 's', target: { kind: 'harness' } })),
    ).toBeNull();
    // 主会话里的进程内子代理（parentTabId 为空）不能弹出
    expect(
      parseDetachSpec(
        q({
          v: 1,
          kind: 'agent',
          scope: 's',
          target: { kind: 'nested', callId: 'c', parentTabId: null },
        }),
      ),
    ).toBeNull();
    expect(parseDetachSpec(q({ v: 1, kind: 'file', scope: 's', key: 'k', href: 'x' }))).toBeNull();
  });

  it('only agents bound to a tab can be detached', () => {
    expect(canDetachTarget({ kind: 'harness', tabId: 't' })).toBe(true);
    expect(canDetachTarget({ kind: 'nomi-task', taskId: 'k' })).toBe(true);
    expect(canDetachTarget({ kind: 'nested', callId: 'c', parentTabId: 'p' })).toBe(true);
    expect(canDetachTarget({ kind: 'nested', callId: 'c', parentTabId: null })).toBe(false);
  });
});
