import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function rendererSources(directory: string) {
  return readdirSync(new URL(directory, import.meta.url), { recursive: true })
    .filter((name) => /\.(?:tsx?|css)$/.test(String(name)))
    .map((name) => ({ name: String(name), source: read(`${directory}/${name}`) }));
}

describe('conversation and preview Markdown ownership', () => {
  it('keeps all preview components and styles independent of Conversation', () => {
    for (const { name, source } of rendererSources('../src/components/ResourcePreview')) {
      expect(source, name).not.toMatch(
        /(?:from\s*|import\s*\(|@import\s*)['"][^'"]*Conversation\//,
      );
    }
  });

  it('keeps all conversation components and styles independent of ResourcePreview', () => {
    for (const { name, source } of rendererSources('../src/components/Conversation')) {
      expect(source, name).not.toMatch(
        /(?:from\s*|import\s*\(|@import\s*)['"][^'"]*ResourcePreview\//,
      );
    }
  });

  it('retains only the neutral resource-open contract between surfaces', () => {
    const context = read('../src/contexts/ResourceContext.tsx');
    expect(context).toContain('open: (href: string');
    expect(context).not.toMatch(/from ['"][^'"]*components\//);
    expect(context).not.toMatch(/documentDir|documentPath/);
    const preview = read('../src/components/ResourcePreview/PreviewMarkdown.tsx');
    expect(preview).not.toMatch(/remarkDelegateReport|remarkCiteRefs/);
  });
});
