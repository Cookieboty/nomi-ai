import { describe, expect, it } from 'vitest';

import { DEFAULT_RECOMMENDATIONS, recommend } from '../src/services/recommendations';

describe('recommend（按职业与兴趣推荐任务）', () => {
  it('没选职业与兴趣：保持原来的默认推荐', () => {
    expect(recommend(null)).toBe(DEFAULT_RECOMMENDATIONS);
    expect(recommend({ role: null, interests: [] })).toBe(DEFAULT_RECOMMENDATIONS);
  });

  it('开发者：Claude Code 与 Codex，偏编程，示例问题带写代码', () => {
    const r = recommend({ role: 'developer', interests: [] });
    expect(r.clis).toEqual(['claude', 'codex']);
    expect(r.coding).toBe(true);
    expect(r.features).toEqual(['ext', 'kb']);
    expect(r.prompts).toEqual(['hello', 'code']);
  });

  it('非开发者但兴趣有编程：也推荐编程助手', () => {
    const r = recommend({ role: 'office', interests: ['coding'] });
    expect(r.clis).toEqual(['claude', 'codex']);
    expect(recommend({ role: 'product', interests: [] }).clis).toEqual(['claude', 'codex']);
    expect(r.coding).toBe(true);
    expect(r.prompts[0]).toBe('hello');
  });

  it('职业优先、去重、条数有上限', () => {
    const r = recommend({
      role: 'office',
      interests: ['writing', 'language', 'learning', 'productivity', 'automation'],
    });
    // 没有职业专属的编程助手：Codex 兜底
    expect(r.clis).toEqual(['codex']);
    expect(r.coding).toBe(false);
    expect(r.features).toEqual(['schedule', 'kb', 'voice']);
    expect(r.prompts).toEqual(['hello', 'weekly', 'todo', 'write']);
  });

  it('学生推荐 Gemini 并以 Codex 兜底；「其他」且没选兴趣时给通用的功能与示例', () => {
    expect(recommend({ role: 'student', interests: [] }).clis).toEqual(['gemini', 'codex']);
    const other = recommend({ role: 'other', interests: [] });
    expect(other.clis).toEqual(['codex']);
    expect(other.features).toEqual(DEFAULT_RECOMMENDATIONS.features);
    expect(other.prompts).toEqual(['hello', 'todo']);
  });
});
