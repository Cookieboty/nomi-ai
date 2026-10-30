import { z } from 'zod';

import type { UserProfileService } from '../../seams/userProfile';
import type { ToolDefinition } from '../../types/common';

export function createPreferenceTools(svc: UserProfileService): ToolDefinition[] {
  const setInput = z
    .object({
      path: z.string().min(1).max(128),
      value: z.unknown(),
      confidence: z.number().min(0).max(1).optional(),
    })
    .strict();

  const getInput = z.object({ path: z.string().min(1).max(128) }).strict();
  const listInput = z.object({}).strict();

  const setPref: ToolDefinition = {
    name: 'set_user_preference',
    description:
      '写入用户偏好（source=user，最高优先级）。path 为点路径，如 preferences.replyStyle',
    input: setInput,
    async execute(input) {
      const { path, value, confidence } = setInput.parse(input);
      const patch = pathToPatch(path, value, confidence);
      await svc.set({ source: 'user', patch, reason: 'set_user_preference tool' });
      return { ok: true };
    },
  };

  const getPref: ToolDefinition = {
    name: 'get_user_preference',
    description: '读取用户偏好；path 为点路径。',
    input: getInput,
    async execute(input) {
      const { path } = getInput.parse(input);
      return { value: svc.getPath(path) };
    },
  };

  const listPref: ToolDefinition = {
    name: 'list_user_preferences',
    description: '返回全部 profile（identity + preferences + habits + dislikes）。',
    input: listInput,
    async execute() {
      return svc.get();
    },
  };

  const forget: ToolDefinition = {
    name: 'forget_user_preferences',
    description: '清空用户偏好薄层（重置为默认）。谨慎操作。',
    input: listInput,
    async execute() {
      await svc.reset();
      return { ok: true };
    },
  };

  return [setPref, getPref, listPref, forget];
}

/**
 * 由 'preferences.replyStyle.value' 之类的点路径构造 deep partial。
 * value 会带上 { source, updatedAt, confidence } 元信息（仅在写 preferences.* 下）。
 */
function pathToPatch(path: string, value: unknown, confidence?: number): Record<string, unknown> {
  const parts = path.split('.');
  const now = Date.now();
  const isPref = parts[0] === 'preferences';

  const leafValue: unknown =
    isPref && !(value && typeof value === 'object' && 'value' in (value as object))
      ? { value, source: 'user', updatedAt: now, confidence: confidence ?? 1 }
      : value;

  const root: Record<string, unknown> = {};
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]!] = {};
    cur = cur[parts[i]!] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = leafValue;
  return root;
}
