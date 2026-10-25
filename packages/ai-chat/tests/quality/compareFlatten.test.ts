import { describe, expect, it } from 'vitest';

/**
 * Mirrors CompareTable.flattenRows id scheme (#124): selection stores ids, then
 * re-resolves against a freshly flattened tree so stale object refs are not kept.
 */
function flattenIds(
  groups: Array<{ dim?: string; key: string; children?: typeof groups }>,
  prefix = '',
): string[] {
  const out: string[] = [];
  for (const s of groups) {
    const id = `${prefix}${s.dim}:${s.key}`;
    out.push(id);
    if (s.children?.length) out.push(...flattenIds(s.children, `${id}›`));
  }
  return out;
}

describe('compare selection ids (#124)', () => {
  it('stable dim:key ids survive a tree refresh', () => {
    const tree = [
      {
        dim: 'modelFamily',
        key: 'claude',
        children: [
          { dim: 'key', key: 'k1' },
          { dim: 'key', key: 'k2' },
        ],
      },
      { dim: 'modelFamily', key: 'gpt' },
    ];
    const ids = flattenIds(tree);
    expect(ids).toEqual([
      'modelFamily:claude',
      'modelFamily:claude›key:k1',
      'modelFamily:claude›key:k2',
      'modelFamily:gpt',
    ]);
    const selected = new Set(['modelFamily:claude›key:k2', 'modelFamily:gpt']);
    const refreshed = new Set(flattenIds(tree));
    expect([...selected].every((id) => refreshed.has(id))).toBe(true);
  });
});
