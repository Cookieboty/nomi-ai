// @vitest-environment happy-dom
/**
 * InteractionLite 在 window 上以捕获方式监听 blur：只有窗口自己失焦才取消这次按下；页面里某个元素失焦
 * （例如先点了别的按钮，焦点离开它）的 blur 也会经过 window 的捕获阶段，不能把按下当成取消。
 */

import { validatePackDirSync } from '@nomi-ai/character-contract/node';
import { repoPath } from '@nomi-ai/repo-paths';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  avatarCharacterFromPack,
  createAvatarRuntime,
  mountAvatar,
  type AvatarHandle,
  type AvatarInteractionEvent,
} from '../src';

const DUMMY = repoPath('characters/test-dummy');

let handle: AvatarHandle | null = null;
let host: HTMLElement | null = null;
let button: HTMLButtonElement | null = null;
let overlay: HTMLElement | null = null;

beforeEach(() => {
  // happy-dom 不画 canvas：命中检测按「光标下是不是别的界面元素」算命中
  overlay = document.createElement('div');
  document.body.appendChild(overlay);
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(overlay);
});

afterEach(() => {
  act(() => handle?.dispose());
  handle = null;
  host?.remove();
  button?.remove();
  overlay?.remove();
  host = button = overlay = null;
  vi.restoreAllMocks();
});

async function mount() {
  const { pack } = validatePackDirSync(DUMMY);
  if (!pack) throw new Error('characters/test-dummy does not validate');
  host = document.createElement('div');
  document.body.appendChild(host);
  button = document.createElement('button');
  document.body.appendChild(button);
  const interactions: AvatarInteractionEvent[] = [];
  await act(async () => {
    handle = mountAvatar(host!, {
      character: avatarCharacterFromPack(pack),
      resolveAsset: (p) => `/character/${p}`,
      runtime: createAvatarRuntime(),
      onInteraction: (e) => interactions.push(e),
    });
  });
  await vi.waitFor(() => expect(host!.querySelector('canvas')).toBeTruthy());
  return { canvas: host!.querySelector('canvas')!, interactions };
}

const at = { clientX: 20, clientY: 20, screenX: 20, screenY: 20, button: 0, pointerId: 1 };

/** 按下 → （中间发生 between）→ 松开，等单击判定（双击窗口 260ms）落下 */
async function clickWith(canvas: HTMLCanvasElement, between: () => void) {
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1, bubbles: true }));
  between();
  window.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0, bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
}

describe('InteractionLite blur handling', () => {
  it('an element losing focus does not cancel the press: the click still lands', async () => {
    const { canvas, interactions } = await mount();
    button!.focus();
    await clickWith(canvas, () => {
      button!.dispatchEvent(new FocusEvent('blur'));
    });
    expect(interactions.map((e) => e.kind)).toEqual(['click']);
  });

  it('the window itself losing focus still cancels the press', async () => {
    const { canvas, interactions } = await mount();
    await clickWith(canvas, () => {
      window.dispatchEvent(new FocusEvent('blur'));
    });
    expect(interactions).toEqual([]);
  });
});
