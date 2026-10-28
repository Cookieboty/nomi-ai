/**
 * 当前角色名（docs/design/core-host-decoupling.md §10.1）：界面里指桌面上那个角色的地方（「显示 X」
 * 「X 已隐藏」「你好，我是 X」）用它，不写死官方角色名；产品名用 `@nomi-ai/types` 的 `brand.appName`。
 *
 * 来源是内核的人设（契约 `persona.get` / `persona.changed`，已按界面语言取好），跟着角色包与语言变化。
 * 还没拿到（或没有契约传输，例如测试与浏览器预览）时用通用称呼「看板娘」。
 */
import { t } from '@nomi-ai/ui';
import { useSyncExternalStore } from 'react';

import { api, hasTransport } from './api';

let name = '';
let started = false;
const subs = new Set<() => void>();

function set(next: unknown): void {
  const v = typeof next === 'string' ? next.trim() : '';
  if (!v || v === name) return;
  name = v;
  subs.forEach((f) => f());
}

function start(): void {
  if (started) return;
  started = true;
  if (!hasTransport()) return;
  api.persona
    .get()
    .then((p) => set(p?.displayName))
    .catch(() => undefined);
  api.on('persona.changed', (p) => set(p?.displayName));
}

/** 当前角色名（当前界面语言）；拿不到时为通用称呼 */
export function characterName(): string {
  start();
  return name || t('ui.mascot-theme.the-mascot');
}

/** React 组件用：角色名变化（换角色包、换语言）时重新渲染 */
export function useCharacterName(): string {
  start();
  useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    () => name,
  );
  return characterName();
}

/** 测试用：直接设定角色名 */
export function setCharacterNameForTest(next: string): void {
  name = next;
  subs.forEach((f) => f());
}
