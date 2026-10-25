/**
 * 技能包（SKILL.md）：一个文件夹 = 一个技能。SKILL.md 以 YAML 风格的 frontmatter 开头
 * （至少 name / description），正文是给模型的操作说明；同目录下可放参考文件。
 * 模型只先看到「名称 + 一句话描述」，需要时再调用 skill_load 读取完整说明（渐进加载）。
 */
import path from 'node:path';

import { t } from '../i18n';

export interface SkillMeta {
  name: string;
  description: string;
  version?: string;
  license?: string;
  author?: string;
}

export class SkillError extends Error {}

/** 极简 frontmatter 解析：只支持 `key: value` 单行（值可带引号） */
export function parseSkillMd(text: string): { meta: SkillMeta; body: string } {
  const src = text.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) throw new SkillError(t('electron.common.skill-md-must-start-with-a-front-matter'));
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const name = (meta.name ?? '').trim();
  const description = (meta.description ?? '').trim();
  if (!validSkillName(name))
    throw new SkillError(t('electron.common.name-may-only-use-lowercase-letters-digits-and'));
  if (!description)
    throw new SkillError(t('electron.common.missing-description-one-sentence-on-when-to-use'));
  return {
    meta: {
      name,
      description: description.slice(0, 1024),
      version: meta.version,
      license: meta.license,
      author: meta.author,
    },
    body: m[2].trim(),
  };
}

export function validSkillName(n: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(n);
}

export function buildSkillMd(meta: SkillMeta, body: string): string {
  const q = (s: string) => (/[:#'"\n]/.test(s) ? JSON.stringify(s) : s);
  const lines = [`name: ${meta.name}`, `description: ${q(meta.description.replace(/\n/g, ' '))}`];
  if (meta.version) lines.push(`version: ${q(meta.version)}`);
  if (meta.license) lines.push(`license: ${q(meta.license)}`);
  if (meta.author) lines.push(`author: ${q(meta.author)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

/** 技能目录内的相对路径 → 绝对路径；越界（../、绝对路径、符号链接名）一律拒绝 */
export function safeJoin(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || /(^|[\\/])\.\.([\\/]|$)/.test(rel))
    throw new SkillError(t('electron.common.only-files-inside-the-skill-folder-can-be'));
  const abs = path.resolve(root, rel);
  const r = path.resolve(root) + path.sep;
  if (!abs.startsWith(r))
    throw new SkillError(t('electron.common.only-files-inside-the-skill-folder-can-be'));
  return abs;
}

/** 注入 system 的技能目录（只有名称 + 描述） */
export function skillsContext(list: SkillMeta[]): string {
  if (!list.length) return '';
  return [
    t('electron.common.available-skills'),
    t('electron.common.the-following-skills-can-be-used-on-demand'),
    ...list.map((s) => `- ${s.name}：${s.description}`),
  ].join('\n');
}
