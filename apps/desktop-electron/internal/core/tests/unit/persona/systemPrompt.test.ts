// 全局 setup 把 fs / path 换成了 mock；要读真实的官方角色包
jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';

import { repoPath } from '@nomi-ai/repo-paths';
import type { Persona } from '@nomi-ai/types';

import { t } from '../../../src/i18n';
import { CHAT_GUIDANCE_KEY, defaultSystemPrompt } from '../../../src/persona/systemPrompt';

const tr = (key: string): string => t(key);

describe('defaultSystemPrompt（内核拼装，契约 persona.systemPrompt）', () => {
  // 官方角色发给模型的默认系统提示（中文界面）：与 2.0.5 逐字一致。界面上的角色名（全名 / 简称）
  // 是另一条路径，改它不能动到这里（docs/BRAND.md）。
  it('pins the official default system prompt', () => {
    const official = JSON.parse(
      fs.readFileSync(repoPath('characters/nomi/persona.json'), 'utf8'),
    ) as Persona;
    expect(defaultSystemPrompt(official, tr)).toBe(
      '你是 Nomi（诺米），住在用户桌面上的 AI 伙伴。\n' +
        '你运行在用户自己的电脑上。语气温暖、专业、可信赖：先给结论，再给步骤；不确定时坦诚说明。' +
        '请结合之前的对话内容，简洁、准确地回答。',
    );
  });

  it('uses the pack identity plus the character-neutral guidance', () => {
    const sys = defaultSystemPrompt({ systemPromptIdentity: 'You are Pip, a paper robot.' }, tr);
    expect(sys).toBe(`You are Pip, a paper robot.\n${tr(CHAT_GUIDANCE_KEY)}`);
    expect(sys).not.toMatch(/Nomi|诺米/);
  });

  it('guidance text carries no character identity; no persona = guidance only', () => {
    expect(tr(CHAT_GUIDANCE_KEY)).not.toMatch(/Nomi|诺米/);
    expect(tr(CHAT_GUIDANCE_KEY)).not.toBe(CHAT_GUIDANCE_KEY);
    expect(defaultSystemPrompt(undefined, tr)).toBe(tr(CHAT_GUIDANCE_KEY));
  });
});
