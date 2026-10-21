/**
 * Popups open instantly: no fade / pop / slide animation and no backdrop blur on modal overlays,
 * dialogs, dropdown menus, toasts, the onboarding overlay or the mascot toolbar panel (owner
 * preference; blur over the scrolling chat also costs compositing every frame).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const css = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of every rule whose selector list contains exactly `selector`. */
function rulesFor(source: string, selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const sels = m[1]!.split(',').map((s) => s.trim());
    if (sels.includes(selector)) out.push(m[2]!);
  }
  return out;
}

const CASES: Array<[file: string, selectors: string[]]> = [
  ['packages/ui/src/styles/base.css', ['.cd-modal-overlay', '.cd-modal', '.cd-toast']],
  ['packages/ui/src/styles/select.css', ['.cd-dropdown__menu']],
  ['packages/ui/src/styles/theme.css', ['.cd-toast']],
  ['packages/ai-chat/src/components/Onboarding/index.module.css', ['.overlay', '.step']],
  ['packages/renderer/src/components/ToolBar/style.module.css', ['.panel']],
];

describe('popups have no open animation or backdrop blur', () => {
  for (const [file, selectors] of CASES) {
    for (const sel of selectors) {
      it(`${file} ${sel}`, () => {
        const rules = rulesFor(css(file), sel);
        expect(rules.length).toBeGreaterThan(0);
        for (const body of rules) {
          expect(body).not.toMatch(/(^|[;\s])animation\s*:(?!\s*none)/);
          expect(body).not.toMatch(/backdrop-filter\s*:(?!\s*none)/);
        }
      });
    }
  }

  it('the modal overlay keeps a translucent (not transparent) backdrop', () => {
    const [overlay] = rulesFor(css('packages/ui/src/styles/base.css'), '.cd-modal-overlay');
    expect(overlay).toMatch(/background:\s*var\(--cd-color-overlay\)/);
    for (const m of css('packages/ui/src/tokens.css').matchAll(
      /--cd-color-overlay:\s*rgba\([^)]*,\s*([\d.]+)\)/g,
    ))
      expect(Number(m[1])).toBeGreaterThanOrEqual(0.3);
  });
});
