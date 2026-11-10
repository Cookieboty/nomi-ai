/**
 * 自定义主题（设置 → 外观 → 我的主题）：存储、主题包导入导出都在内核（theme.custom*），
 * 令牌推导与套用在 @nomi-ai/ui 的 customTheme / theme。
 */
import {
  parseCustomTheme,
  type CustomThemeDef,
  type SeedKey,
  type ThemeBackground,
  type ThemeBase,
  type ThemeVariant,
} from '@nomi-ai/ui';

import { api, hasTransport } from './api';

const parseList = (v: unknown): CustomThemeDef[] =>
  (Array.isArray(v) ? v : []).map(parseCustomTheme).filter((x): x is CustomThemeDef => !!x);

export async function listCustomThemes(): Promise<CustomThemeDef[]> {
  if (!hasTransport()) return [];
  return parseList(await api.theme.customList());
}

export interface CustomThemeDraft {
  id?: string;
  name: Record<string, string>;
  author?: string;
  base: ThemeBase;
  seeds: Partial<Record<SeedKey, string>>;
  tokens?: Record<string, string>;
  variants?: Partial<Record<ThemeBase, ThemeVariant>>;
  background?: ThemeBackground;
}

export async function saveCustomTheme(draft: CustomThemeDraft): Promise<CustomThemeDef> {
  const saved = parseCustomTheme(await api.theme.customSave(draft));
  if (!saved) throw new Error('invalid theme');
  return saved;
}

export const deleteCustomTheme = (id: string): Promise<void> => api.theme.customDelete({ id });

/** 弹出选择框导入主题包；取消 → null */
export async function importThemePack(): Promise<CustomThemeDef | null> {
  const v = await api.theme.customImport();
  return v ? parseCustomTheme(v) : null;
}

/** 拖进导入框的文件：视图读出字节给内核（契约走 WebSocket，帧上限 16 MB，base64 后约 12 MB 原文件） */
export const THEME_DROP_MAX_BYTES = 12 * 1024 * 1024;

export async function importThemePackFile(file: File): Promise<CustomThemeDef> {
  const data = new Uint8Array(await file.arrayBuffer());
  const def = parseCustomTheme(await api.theme.customImportData({ data }));
  if (!def) throw new Error('invalid theme');
  return def;
}

/** 弹出保存框写出主题包模板；取消 → null，否则返回路径 */
export const downloadThemeTemplate = (): Promise<string | null> => api.theme.customTemplate();

/** 弹出选择框选背景图（内核暂存，保存主题时才归位）；取消 → null */
export const pickThemeBackground = (): Promise<string | null> => api.theme.customPickBackground();

/** 弹出保存框导出主题包；取消 → null，否则返回路径 */
export const exportThemePack = (id: string): Promise<string | null> =>
  api.theme.customExport({ id });

/** 内核的错误文案已按界面语言翻译，原样显示 */
export const themeErrorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
