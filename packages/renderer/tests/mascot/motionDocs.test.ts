import fs from 'node:fs';

import { ACTIONS } from '@nomi-ai/avatar-runtime';
import { repoPath } from '@nomi-ai/repo-paths';
import { t } from '@nomi-ai/ui';
import { describe, expect, it } from 'vitest';

// 动作的显示名是界面文案（i18n key 在 avatar-runtime 里，翻译在 @nomi-ai/ui）
describe('action labels', () => {
  it('every action label key shows Chinese in the default language', () => {
    for (const a of ACTIONS) expect(t(a.label), a.id).toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('docs', () => {
  it('docs/features/mascot.md lists every action with its label and the right count', () => {
    const doc = fs.readFileSync(repoPath('docs/features/mascot.md'), 'utf8');
    for (const a of ACTIONS) {
      expect(doc, a.id).toContain(`\`${a.id}\``);
      expect(doc, a.id).toContain(t(a.label));
    }
    expect(doc).toContain(`${ACTIONS.length} 个命名动作`);
  });
});
