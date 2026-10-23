import { describe, expect, it } from 'vitest';

import type { BackendModelCatalog } from '../src/services/harnessClient';
import { imageSupportFor } from '../src/utils/cliImageSupport';

const m = (id: string, vision?: boolean) => ({
  id,
  label: id.toUpperCase(),
  reasoning: false,
  efforts: [],
  ...(vision === undefined ? {} : { vision }),
});
const catalog: BackendModelCatalog = {
  backend: 'codex',
  models: [m('see', true), m('blind', false), m('unknown')],
  defaultModel: m('see', true),
};

describe('编程助手附图：看当前模型的能力', () => {
  it('模型明确不支持看图：拦下并说明是哪个模型', () => {
    const r = imageSupportFor({ backend: 'codex', modelOverride: 'blind' }, catalog);
    expect(r.capability).toBe('none');
    expect(r.reason).toContain('BLIND');
    expect(r.reason).not.toContain('切回 Nomi');
  });

  it('支持 / 不知道：放行；没选模型时看 CLI 默认模型', () => {
    expect(imageSupportFor({ backend: 'codex', modelOverride: 'see' }, catalog).capability).toBe(
      'full',
    );
    expect(
      imageSupportFor({ backend: 'codex', modelOverride: 'unknown' }, catalog).capability,
    ).toBe('full');
    expect(imageSupportFor({ backend: 'codex', modelOverride: null }, catalog).capability).toBe(
      'full',
    );
    expect(
      imageSupportFor(
        { backend: 'codex', modelOverride: null },
        { ...catalog, defaultModel: m('blind', false) },
      ).capability,
    ).toBe('none');
    // 目录还没读到：不拦
    expect(imageSupportFor({ backend: 'claude', modelOverride: 'x' }, null).capability).toBe(
      'full',
    );
  });

  it('dsh：命令行没有图片输入，与模型无关', () => {
    const r = imageSupportFor({ backend: 'dsh', modelOverride: null }, null);
    expect(r.capability).toBe('none');
    expect(r.reason).toContain('dsh');
  });
});
