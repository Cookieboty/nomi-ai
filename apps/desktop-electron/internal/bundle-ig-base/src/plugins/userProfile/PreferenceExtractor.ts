import type { ProfilePatch } from '../../seams/userProfile';

/**
 * 基于规则的显式偏好抽取器。
 *
 * 触发条件：用户消息里出现明确的「请以中文回复」「请用要点」「不要写注释」这种祈使句。
 * 命中即产出 ProfilePatch(source='inferred', confidence=0.9)。
 *
 * 骨架版：预置四条规则；真实规则集在 P5+ 扩展。
 */
export interface ExtractRule {
  test: (utterance: string) => boolean;
  build: (utterance: string, now: number) => ProfilePatch;
}

const rules: ExtractRule[] = [
  {
    test: (u) => /请?(用|以)中文(回复|回答|说)/.test(u),
    build: (_u, now) => ({
      source: 'inferred',
      reason: 'user asked to reply in Chinese',
      patch: {
        preferences: {
          replyLanguage: { value: 'zh', source: 'inferred', updatedAt: now, confidence: 0.9 },
        },
      },
    }),
  },
  {
    test: (u) => /reply in english|please answer in english/i.test(u),
    build: (_u, now) => ({
      source: 'inferred',
      reason: 'user asked to reply in English',
      patch: {
        preferences: {
          replyLanguage: { value: 'en', source: 'inferred', updatedAt: now, confidence: 0.9 },
        },
      },
    }),
  },
  {
    test: (u) => /简短|要点|bullet|一句话/.test(u),
    build: (_u, now) => ({
      source: 'inferred',
      reason: 'user prefers concise/bullet style',
      patch: {
        preferences: {
          replyStyle: { value: 'bullet', source: 'inferred', updatedAt: now, confidence: 0.8 },
        },
      },
    }),
  },
  {
    test: (u) => /不要(加|写)注释|no comments/i.test(u),
    build: (_u, _now) => ({
      source: 'inferred',
      reason: 'user dislikes comments',
      patch: {
        preferences: {
          codeStyle: { comments: 'minimal' },
        },
      },
    }),
  },
];

export class PreferenceExtractor {
  extract(utterance: string, now: number = Date.now()): ProfilePatch[] {
    return rules.filter((r) => r.test(utterance)).map((r) => r.build(utterance, now));
  }
}
