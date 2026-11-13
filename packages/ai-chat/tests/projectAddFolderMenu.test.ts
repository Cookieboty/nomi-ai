import { describe, expect, it } from 'vitest';

import { placeAddFolderMenu } from '../src/components/ProjectDialog/placeMenu';

const anchor = { top: 700, bottom: 740, left: 40 };

describe('placeAddFolderMenu', () => {
  it('flips above the trigger when the dialog bottom has no room', () => {
    const box = placeAddFolderMenu(anchor, { width: 800, height: 780 });
    expect(box.bottom).toBe(780 - anchor.top + 4);
    expect(box.top).toBeUndefined();
    expect(box.maxHeight).toBeLessThanOrEqual(anchor.top);
    expect(box.left).toBe(40);
  });

  it('opens below when there is room, and shifts left so it stays on screen', () => {
    const box = placeAddFolderMenu({ top: 40, bottom: 80, left: 700 }, { width: 800, height: 900 });
    expect(box.top).toBe(84);
    expect(box.bottom).toBeUndefined();
    expect(box.left + box.width).toBeLessThanOrEqual(800 - 8);
  });
});
