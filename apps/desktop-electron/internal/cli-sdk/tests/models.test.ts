import { describe, expect, it } from 'vitest';

import { isValidModelId } from '../src/models';

describe('isValidModelId', () => {
  it('厂商模型 id：字母数字 . _ - : / [ ]，中间可以有单个空格', () => {
    for (const ok of [
      'opus',
      'gpt-5.6-sol',
      'amux/anthropic/claude-fable-5-1',
      'claude-opus-4-6[1m]',
    ])
      expect(isValidModelId(ok)).toBe(true);
    expect(isValidModelId('Qwen 3 Max')).toBe(true);
    expect(isValidModelId('prov/Qwen 3 Max')).toBe(true);
    // 首尾空格按去掉后判断
    expect(isValidModelId('  opus ')).toBe(true);
  });

  it('不接受：空、以 - 开头、引号、换行 / Tab、连续空格、超长', () => {
    for (const bad of ['', ' ', '-rf', 'a"b', "a'b", 'a\nb', 'a\tb', 'a  b', 'x'.repeat(129)])
      expect(isValidModelId(bad)).toBe(false);
  });
});
