import { readFileSync } from 'node:fs';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(repoPath(rel), 'utf8');
const ruleBodies = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|[}/])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map(
    (match) => match[1] ?? '',
  );
};

describe('conversation typography boundaries', () => {
  it('keeps a 14px / 22px CSS fallback and fixed control sizes', () => {
    const css = read('packages/ai-chat/src/components/Conversation/index.module.css');
    const root = ruleBodies(css, '.root').join('\n');
    expect(root).toContain('--conv-text: 14px');
    expect(root).toContain('--conv-leading: 22px');
    expect(root).toContain('--conv-code: 14px');
    expect(root).toContain('--conv-ui: 14px');
    expect(root).toContain('--conv-meta: 13px');
  });

  it('keeps the message input fixed at 14px', () => {
    const css = read('packages/ai-chat/src/components/MessageInput/index.module.css');
    const rules = ruleBodies(css, '.messageTextarea');
    expect(rules.at(-1)).toContain('font-size: 14px');
    expect(css).not.toContain('--composer-text');
  });

  it('keeps platform-specific sizing for ordinary UI only', () => {
    const css = read('packages/ai-chat/src/App.css');
    expect(css).toMatch(/html\[data-platform='win32'\][\s\S]*?--cd-font-size-md:\s*15px/);
    expect(css).toMatch(/html\[data-platform='linux'\][\s\S]*?--cd-font-size-md:\s*14\.5px/);
  });
});
