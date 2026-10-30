import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CHARACTER_CONTRACT_VERSION,
  CONTRACT,
  HITBOX_IDS,
  ONBOARDING_FILES,
  PACK_MODES,
  SEMANTIC_ACTIVITIES,
  SEMANTIC_EMOTIONS,
  SEMANTIC_GESTURES,
} from '../src';

const pkgRoot = join(fileURLToPath(import.meta.url), '..', '..');

describe('contract.json stays in sync with the typed constants', () => {
  it('versions', () => {
    expect(CONTRACT.contractVersion).toBe(CHARACTER_CONTRACT_VERSION);
  });

  it('modes, hitboxes, onboarding', () => {
    expect(CONTRACT.modes).toEqual([...PACK_MODES]);
    expect(CONTRACT.hitboxIds).toEqual([...HITBOX_IDS]);
    expect(CONTRACT.onboarding.files).toEqual([...ONBOARDING_FILES]);
  });

  it('semantic vocabulary', () => {
    expect(CONTRACT.mapping.emotions).toEqual([...SEMANTIC_EMOTIONS]);
    expect(CONTRACT.mapping.activities).toEqual([...SEMANTIC_ACTIVITIES]);
    expect(CONTRACT.mapping.gestures).toEqual([...SEMANTIC_GESTURES]);
  });

  it('sprite action count matches the list', () => {
    expect(CONTRACT.sprite.actionIds).toHaveLength(CONTRACT.sprite.actionCount);
  });
});

describe('core entry is runtime-agnostic', () => {
  // 核心入口要能在浏览器里用：除 node.ts 外不得 import node 内置模块或 electron。
  const srcDir = join(pkgRoot, 'src');
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts') && f !== 'node.ts');

  it.each(files)('%s has no node / electron imports', (file) => {
    const text = readFileSync(join(srcDir, file), 'utf8');
    const specifiers = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specifiers) {
      expect(s).not.toMatch(/^(node:|electron$|fs$|path$|os$|url$|crypto$|child_process$)/);
    }
  });
});
