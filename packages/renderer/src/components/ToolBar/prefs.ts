/** 工具栏偏好（仅本机 localStorage）：收起为单按钮 + 工具栏样式。 */
export type ToolbarStyleId = 'dark' | 'light' | 'glass' | 'minimal';
export interface ToolbarPrefs {
  compact: boolean;
  style: ToolbarStyleId;
}

/** 四种工具栏样式（设计稿「工具栏样式」）；深色胶囊为推荐的默认样式 */
export const TOOLBAR_STYLES: Array<{ id: ToolbarStyleId; label: string; swatch: string }> = [
  { id: 'dark', label: '深色胶囊（推荐）', swatch: '#3d3f45' },
  { id: 'light', label: '浅色胶囊', swatch: '#ffffff' },
  { id: 'glass', label: '毛玻璃', swatch: 'rgba(214, 222, 236, 0.75)' },
  { id: 'minimal', label: '极简', swatch: 'transparent' },
];

/** 常驻在工具栏上的按钮（顺序即设计稿顺序）；其余进入「更多」面板 */
export const PRIMARY_TOOLS = ['ai-chat', 'voice-input', 'task-board', 'motion', 'voice-settings'];

const KEY = 'mascot-toolbar-prefs';
const DEFAULTS: ToolbarPrefs = { compact: false, style: 'dark' };

/** 旧版本的「配色」：浅色 → 浅色胶囊，其余（跟随主题 / 静谧深色 / 暖色）→ 深色胶囊 */
function fromLegacyPalette(palette: unknown): ToolbarStyleId {
  return palette === 'light' ? 'light' : 'dark';
}

export function loadToolbarPrefs(): ToolbarPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ToolbarPrefs> & {
      palette?: unknown;
    };
    return {
      compact: raw.compact === true,
      style: TOOLBAR_STYLES.some((s) => s.id === raw.style)
        ? (raw.style as ToolbarStyleId)
        : raw.palette !== undefined
          ? fromLegacyPalette(raw.palette)
          : DEFAULTS.style,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveToolbarPrefs(p: ToolbarPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}
