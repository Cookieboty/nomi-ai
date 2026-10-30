/**
 * AppConfig —— 业务配置类型（provider 选择 / 默认模型 / 快捷键 / UI 偏好）。
 *
 * 只保留 **JSON-safe** 字段，方便持久化与 IPC 分发。
 */

export type ThemePref = 'light' | 'dark' | 'system';

export interface ProviderChoice {
  /** LLM provider id，例如 'deepseek' / 'openai' */
  id: string;
  /** 模型 id，例如 'deepseek-chat' */
  model: string;
  /** 是否作为默认 provider（有且只有一个） */
  default?: boolean;
}

export interface ShortcutBinding {
  /** 命令 id，例如 'agent.stop' / 'session.new' */
  command: string;
  /** 快捷键描述，Electron 风格，如 'CommandOrControl+Shift+P' */
  accelerator: string;
}

export interface UiPreferences {
  theme?: ThemePref;
  language?: string;
  fontSizePx?: number;
  compact?: boolean;
}

export interface AppConfig {
  providers: ProviderChoice[];
  shortcuts: ShortcutBinding[];
  ui: UiPreferences;
  /** 允许的危险工具白名单（会在 runtime 层与 UI 二次确认合并） */
  autoAcceptTools?: string[];
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  providers: [],
  shortcuts: [],
  ui: { theme: 'system' },
  autoAcceptTools: [],
};
