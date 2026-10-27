import { getDictionary } from '@nomi-ai/i18n';
import { describe, expect, it } from 'vitest';

import { t } from '../src';

describe('词典', () => {
  it('合并后的词典按语言缓存：t() 每次都查它，不能每次重新合并几千条（界面会明显卡顿）', () => {
    expect(getDictionary('zh')).toBe(getDictionary('zh'));
    expect(getDictionary('en')).toBe(getDictionary('en'));
    expect(getDictionary('zh')).not.toBe(getDictionary('en'));
    // 一万次翻译应在毫秒级完成（每次重新合并时要几秒）
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) t('ui.models.choose-a-model');
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('用户文本是 __proto__ / constructor / toString 等继承属性名时原样返回字符串（#142）', () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(t(k)).toBe(k);
      expect(t('ui.chat-settings.failed-to-send-message', k)).toContain(k);
    }
    expect(Object.getPrototypeOf(getDictionary('zh'))).toBeNull();
  });
});
