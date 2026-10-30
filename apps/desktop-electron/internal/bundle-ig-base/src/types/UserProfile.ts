// 用户偏好薄层记忆
//
// 原则：
// - 结构化、可解释、可编辑、可导出
// - 每条 preference 都携带 source（'user' | 'inferred' | 'distilled'），可回溯
// - LLM 只读；写入永远走 Extractor / Distiller / UI 中间件

export type PreferenceSource = 'user' | 'inferred' | 'distilled';

export interface PreferenceValue<T = string> {
  value: T;
  source: PreferenceSource;
  updatedAt: number;
  /** 蒸馏或规则命中的置信度 0~1 */
  confidence?: number;
}

/** 稳定人设：姓名 / 昵称 / 时区 / 母语 */
export interface UserIdentity {
  displayName?: string;
  nickname?: string;
  timezone?: string;
  locale?: string;
}

/** 编码偏好 */
export interface CodeStylePreference {
  language?: string[];
  framework?: string[];
  indent?: 'tab' | 2 | 4;
  quotes?: 'single' | 'double';
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  comments?: 'minimal' | 'verbose';
}

/** 交互偏好 */
export interface UserPreferences {
  replyLanguage?: PreferenceValue<string>;
  replyStyle?: PreferenceValue<'concise' | 'detailed' | 'bullet' | 'stepwise'>;
  tone?: PreferenceValue<'formal' | 'casual' | 'cute' | 'strict'>;
  codeStyle?: CodeStylePreference;
  ttsVoiceId?: PreferenceValue<string>;
  autoAcceptTools?: string[];
  privacy?: {
    allowScreenCapture?: boolean;
    allowClipboardRead?: boolean;
    allowFileWrite?: boolean;
  };
}

/** 隐式习惯统计（EMA / 计数） */
export interface UserHabits {
  activeHours?: number[]; // length 24
  avgSessionLen?: number;
  stopGenerationRate?: number;
  regenRate?: number;
  topTools?: Array<{ tool: string; count: number }>;
  topTopics?: Array<{ topic: string; count: number }>;
  updatedAt?: number;
}

/** 顶层 UserProfile */
export interface UserProfile {
  version: number;
  identity: UserIdentity;
  preferences: UserPreferences;
  habits: UserHabits;
  dislikes: string[];
  createdAt: number;
  updatedAt: number;
}

export const CURRENT_USER_PROFILE_VERSION = 1;

export function makeDefaultUserProfile(now: number = Date.now()): UserProfile {
  return {
    version: CURRENT_USER_PROFILE_VERSION,
    identity: {},
    preferences: {},
    habits: {},
    dislikes: [],
    createdAt: now,
    updatedAt: now,
  };
}
