/**
 * 新手引导里的「职业与兴趣」：主进程存进 onboarding.json，渲染进程据此推荐任务
 * （先装哪个编程助手、欢迎页的示例问题、「开始使用」里的功能）。主进程与渲染进程共用 id 与校验。
 */
export const USER_ROLES = [
  'developer',
  'product',
  'creator',
  'office',
  'student',
  'other',
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_INTERESTS = [
  'coding',
  'writing',
  'language',
  'learning',
  'productivity',
  'automation',
] as const;
export type UserInterest = (typeof USER_INTERESTS)[number];

export interface UserProfile {
  /** 没选为 null */
  role: UserRole | null;
  /** 可多选，按 USER_INTERESTS 的顺序、去重 */
  interests: UserInterest[];
}

export const EMPTY_USER_PROFILE: UserProfile = { role: null, interests: [] };

/** 来自 IPC / 磁盘的任意值 → 合法的 UserProfile（未知 id 丢掉） */
export function normalizeUserProfile(v: unknown): UserProfile {
  const o = (v && typeof v === 'object' ? v : {}) as { role?: unknown; interests?: unknown };
  const role = USER_ROLES.find((r) => r === o.role) ?? null;
  const picked = Array.isArray(o.interests) ? o.interests : [];
  const interests = USER_INTERESTS.filter((x) => picked.includes(x));
  return { role, interests };
}

/** 用户选过职业或兴趣 */
export const hasUserProfile = (p: UserProfile): boolean =>
  p.role !== null || p.interests.length > 0;
