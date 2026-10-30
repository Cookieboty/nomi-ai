import { describe, expect, it } from 'vitest';

import { inferToolDanger } from '../src/ai-sdk/mcpBridge';

describe('inferToolDanger', () => {
  it('信任显式 destructiveHint', () => {
    expect(inferToolDanger({ name: 'get_x', annotations: { destructiveHint: true } }, 'http')).toBe(
      true,
    );
  });

  it('显式 readOnlyHint 的工具不危险（即使名字像 write）', () => {
    expect(
      inferToolDanger(
        { name: 'write_meta', annotations: { readOnlyHint: true, destructiveHint: false } },
        'stdio',
      ),
    ).toBe(false);
  });

  it('stdio 服务器的非只读工具一律危险', () => {
    expect(inferToolDanger({ name: 'whatever' }, 'stdio')).toBe(true);
  });

  it('远程 http 服务器仅按名字片段判定危险工具', () => {
    expect(inferToolDanger({ name: 'run_command' }, 'http')).toBe(true);
    expect(inferToolDanger({ name: 'delete_file' }, 'sse')).toBe(true);
    expect(inferToolDanger({ name: 'send_email' }, 'http')).toBe(true);
  });

  it('远程只读查询类工具不标危险', () => {
    expect(inferToolDanger({ name: 'search_notes' }, 'http')).toBe(false);
    expect(inferToolDanger({ name: 'get_weather' }, 'http')).toBe(false);
  });

  it('不带 annotations 时按名字保守判定', () => {
    expect(inferToolDanger({ name: 'fetch_url' }, 'http')).toBe(true);
  });
});
