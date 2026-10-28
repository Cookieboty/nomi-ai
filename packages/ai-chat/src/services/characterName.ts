/**
 * 当前角色名（docs/design/core-host-decoupling.md §10.1、docs/BRAND.md）：界面里指桌面上那个角色的地方
 * 用它，不写死官方角色名；产品名用 `@nomi-ai/types` 的 `brand.appName`。
 *
 * 角色有全名和简称（人设的 displayName / shortName，docs/BRAND.md）：第一次提到时用全名
 * （`characterFullName`：欢迎语「你好，我是 X」），之后用简称（`characterName`：「显示 X」「X 大小」）。
 * 名字放进句子用 `tName`（`@nomi-ai/ui`），中文里名字与汉字之间按排版补空格。
 *
 * 来源是内核的人设（契约 `persona.get` / `persona.changed`，已按界面语言取好），跟着角色包与语言变化。
 * 还没拿到（或没有契约传输，例如测试与浏览器预览）时用通用称呼「看板娘」。
 */
import { t } from '@nomi-ai/ui';
import { useSyncExternalStore } from 'react';

import { api, hasTransport } from './api';

interface Names {
  full: string;
  short: string;
}

let names: Names = { full: '', short: '' };
let started = false;
const subs = new Set<() => void>();

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function set(p: { displayName?: unknown; shortName?: unknown } | undefined): void {
  const full = str(p?.displayName);
  if (!full) return;
  const short = str(p?.shortName) || full;
  if (full === names.full && short === names.short) return;
  names = { full, short };
  subs.forEach((f) => f());
}

function start(): void {
  if (started) return;
  started = true;
  if (!hasTransport()) return;
  api.persona
    .get()
    .then((p) => set(p))
    .catch(() => undefined);
  api.on('persona.changed', (p) => set(p));
}

/** 当前角色的简称（当前界面语言）；拿不到时为通用称呼 */
export function characterName(): string {
  start();
  return names.short || t('ui.mascot-theme.the-mascot');
}

/** 当前角色的全名（第一次提到时用）；拿不到时为通用称呼 */
export function characterFullName(): string {
  start();
  return names.full || t('ui.mascot-theme.the-mascot');
}

/** React 组件用：角色名变化（换角色包、换语言）时重新渲染；返回简称 */
export function useCharacterName(): string {
  start();
  useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    () => names,
  );
  return characterName();
}

/** 测试用：直接设定角色名（只给一个时全名与简称相同） */
export function setCharacterNameForTest(short: string, full: string = short): void {
  names = { full, short };
  subs.forEach((f) => f());
}
