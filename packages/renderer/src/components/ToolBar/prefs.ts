/** 工具栏偏好（仅本机 localStorage）：收起为单按钮 + 配色。 */
export type PaletteId = 'theme' | 'calm' | 'light' | 'warm';
export interface ToolbarPrefs {
  compact: boolean;
  palette: PaletteId;
}

export const PALETTES: Array<{ id: PaletteId; label: string; swatch: string }> = [
  { id: 'theme', label: '跟随主题（默认）', swatch: 'var(--cd-color-surface-raised)' },
  { id: 'calm', label: '静谧深色', swatch: '#3a4659' },
  { id: 'light', label: '浅色', swatch: '#e7ecf2' },
  { id: 'warm', label: '暖色', swatch: '#7a5f4e' },
];

/** 常驻在工具栏上的按钮；其余进入「更多」菜单 */
export const PRIMARY_TOOLS = [
  'ai-chat',
  'voice-input',
  'switch-model',
  'motion',
  'voice-settings',
  'close-mascot',
];

const KEY = 'mascot-toolbar-prefs';
const DEFAULTS: ToolbarPrefs = { compact: false, palette: 'theme' };

export function loadToolbarPrefs(): ToolbarPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ToolbarPrefs>;
    return {
      compact: raw.compact === true,
      palette: PALETTES.some((p) => p.id === raw.palette) ? (raw.palette as PaletteId) : 'theme',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveToolbarPrefs(p: ToolbarPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式等：忽略 */
  }
}
