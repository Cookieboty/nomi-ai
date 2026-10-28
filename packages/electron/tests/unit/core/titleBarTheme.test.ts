import { appearanceFor, THEME_IDS } from '@nomi-ai/core/theme/ThemeService';

import { THEME_CHROME } from '../../../src/core/titleBar';

// 主题偏好在内核（ThemeService），标题栏底色在宿主（titleBar）：两边的深浅判断要一致
describe('titleBar × theme', () => {
  it('深色 / 浅色外观与各主题标题栏底色一致', () => {
    for (const id of THEME_IDS) {
      const bg = THEME_CHROME[id].bg;
      const sum = [1, 3, 5].reduce((a, i) => a + parseInt(bg.slice(i, i + 2), 16), 0);
      expect(appearanceFor(id)).toBe(sum < 3 * 128 ? 'dark' : 'light');
    }
  });
});
