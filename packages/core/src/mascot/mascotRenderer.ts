/**
 * 看板娘渲染器设置（2.0.5 计划 §5）：userData/settings.json 的 `mascot.renderer`，`'svg' | 'rive'`，
 * 缺省 / 非法值一律 `'svg'`（老用户升级后同样是 svg）。Go 版 core/settings 读写同一文件、同一形状。
 */
import fs from 'node:fs';
import path from 'node:path';

export type MascotRenderer = 'svg' | 'rive';

export const settingsFile = (userData: string): string => path.join(userData, 'settings.json');

function readSettings(userData: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(settingsFile(userData), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function normalizeMascotRenderer(v: unknown): MascotRenderer {
  return v === 'rive' ? 'rive' : 'svg';
}

export function readMascotRenderer(userData: string): MascotRenderer {
  const m = readSettings(userData).mascot as { renderer?: unknown } | undefined;
  return normalizeMascotRenderer(m?.renderer);
}

export function writeMascotRenderer(userData: string, renderer: unknown): MascotRenderer {
  const next = normalizeMascotRenderer(renderer);
  const data = readSettings(userData);
  const mascot = data.mascot && typeof data.mascot === 'object' ? (data.mascot as object) : {};
  data.mascot = { ...mascot, renderer: next };
  fs.mkdirSync(userData, { recursive: true });
  const tmp = `${settingsFile(userData)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, settingsFile(userData));
  return next;
}
