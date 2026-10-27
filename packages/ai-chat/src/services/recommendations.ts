/**
 * 按新手引导里选的职业与兴趣推荐任务：先装哪个编程助手、「开始使用」里列哪些功能、欢迎页给哪些示例问题。
 * 只是规则表（纯函数，便于单测）；没选过职业与兴趣时保持原来的默认推荐。
 */
import type { BuiltinCliId } from '@nomi-ai/cli-plugins';
import { hasUserProfile, type UserInterest, type UserProfile, type UserRole } from '@nomi-ai/types';

/** 「开始使用」里推荐的功能（点击跳到对应设置页） */
export type RecommendedFeature = 'kb' | 'schedule' | 'voice' | 'ext';
/** 欢迎页的示例问题 */
export type QuickPromptId =
  'hello' | 'code' | 'todo' | 'weekly' | 'spec' | 'write' | 'language' | 'learn';

export interface Recommendations {
  /** 推荐安装的编程助手，按优先级；最后总有 Codex 兜底（通用，什么职业都用得上） */
  clis: BuiltinCliId[];
  /** 偏编程：助手模式下「安装编程助手」也不标「可选」 */
  coding: boolean;
  features: RecommendedFeature[];
  /** 第一个总是「打个招呼」 */
  prompts: QuickPromptId[];
}

interface Rule {
  clis?: BuiltinCliId[];
  features?: RecommendedFeature[];
  prompts?: QuickPromptId[];
}

const ROLE_RULES: Record<UserRole, Rule> = {
  developer: { clis: ['claude', 'codex'], features: ['ext', 'kb'], prompts: ['code'] },
  product: { clis: ['claude'], features: ['kb', 'schedule'], prompts: ['spec'] },
  creator: { features: ['voice', 'kb'], prompts: ['write'] },
  office: { features: ['schedule', 'kb'], prompts: ['weekly', 'todo'] },
  student: { clis: ['gemini'], features: ['kb', 'voice'], prompts: ['learn'] },
  other: {},
};

const INTEREST_RULES: Record<UserInterest, Rule> = {
  coding: { clis: ['claude', 'codex'], features: ['ext'], prompts: ['code'] },
  writing: { prompts: ['write'] },
  language: { features: ['voice'], prompts: ['language'] },
  learning: { features: ['kb'], prompts: ['learn'] },
  productivity: { features: ['schedule'], prompts: ['todo'] },
  automation: { features: ['ext'] },
};

/** 没选职业与兴趣时的推荐（与加入职业选择之前一致） */
export const DEFAULT_RECOMMENDATIONS: Recommendations = {
  clis: ['claude', 'codex'],
  coding: false,
  features: ['kb', 'ext'],
  prompts: ['hello', 'code', 'todo'],
};

/** 兜底推荐的编程助手：职业规则里没给到时也推荐它 */
const FALLBACK_CLI: BuiltinCliId = 'codex';

const MAX_FEATURES = 3;
/** 除「打个招呼」外最多几个示例问题 */
const MAX_PROMPTS = 3;

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

export function recommend(profile: UserProfile | null): Recommendations {
  if (!profile || !hasUserProfile(profile)) return DEFAULT_RECOMMENDATIONS;
  // 职业优先，其次按兴趣的固定顺序
  const rules = [
    ...(profile.role ? [ROLE_RULES[profile.role]] : []),
    ...profile.interests.map((i) => INTEREST_RULES[i]),
  ];
  const clis = uniq([...rules.flatMap((r) => r.clis ?? []), FALLBACK_CLI]);
  const features = uniq(rules.flatMap((r) => r.features ?? [])).slice(0, MAX_FEATURES);
  const prompts = uniq(rules.flatMap((r) => r.prompts ?? [])).slice(0, MAX_PROMPTS);
  return {
    clis,
    coding: profile.role === 'developer' || profile.interests.includes('coding'),
    features: features.length ? features : DEFAULT_RECOMMENDATIONS.features,
    prompts: ['hello', ...(prompts.length ? prompts : ['todo' as const])],
  };
}

/** 示例问题的文案（i18n key）：按钮上的短标签与点击后发出的问题 */
export const QUICK_PROMPT_TEXT: Record<QuickPromptId, { label: string; prompt: string }> = {
  hello: { label: 'ui.foundation.say-hello', prompt: 'ui.foundation.hi-please-introduce-yourself' },
  code: { label: 'ui.foundation.write-some-code', prompt: 'ui.foundation.help-me-write-some-code' },
  todo: {
    label: 'ui.foundation.organize-today-s-to-dos',
    prompt: 'ui.foundation.help-me-organize-today-s-to-dos',
  },
  weekly: { label: 'ui.foundation.quick-weekly', prompt: 'ui.foundation.quick-weekly-prompt' },
  spec: { label: 'ui.foundation.quick-spec', prompt: 'ui.foundation.quick-spec-prompt' },
  write: { label: 'ui.foundation.quick-write', prompt: 'ui.foundation.quick-write-prompt' },
  language: {
    label: 'ui.foundation.quick-language',
    prompt: 'ui.foundation.quick-language-prompt',
  },
  learn: { label: 'ui.foundation.quick-learn', prompt: 'ui.foundation.quick-learn-prompt' },
};
