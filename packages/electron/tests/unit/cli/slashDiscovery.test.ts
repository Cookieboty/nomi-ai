jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.unmock('os');
jest.unmock('node:os');
jest.unmock('child_process');
jest.unmock('node:child_process');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  discoverSlash,
  expandSlash,
  expandTemplate,
  gitDiff,
  parseFrontmatter,
  projectChain,
  splitArgs,
} from '../../../src/cli/slashDiscovery';

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe('slashDiscovery', () => {
  let root: string;
  let home: string;
  let proj: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-'));
    home = path.join(root, 'home');
    proj = path.join(root, 'proj');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'pkg', 'a'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('parses frontmatter incl. block scalars, and ignores files not starting with ---', () => {
    const r = parseFrontmatter(
      '---\nname: x\ndescription: >\n  first\n  second\nargument-hint: "[a] [b]"\n---\nbody',
    );
    expect(r.meta).toMatchObject({
      name: 'x',
      description: 'first second',
      'argument-hint': '[a] [b]',
    });
    expect(r.body).toBe('body');
    expect(parseFrontmatter('\n---\na: b\n---\nz').meta).toEqual({});
  });

  it('walks up to the git root and not beyond', () => {
    const chain = projectChain(path.join(proj, 'pkg', 'a'));
    expect(chain).toEqual([path.join(proj, 'pkg', 'a'), path.join(proj, 'pkg'), proj]);
    expect(projectChain(path.join(root, 'home'))).toEqual([path.join(root, 'home')]);
  });

  it('discovers Claude commands (namespaced), skills, agents and .mcp.json server names only', () => {
    write(
      path.join(proj, '.claude/commands/frontend/component.md'),
      '---\ndescription: Make a component\nargument-hint: "[name]"\n---\nMake $ARGUMENTS',
    );
    write(path.join(proj, '.claude/commands/deploy.md'), 'Deploy it\n');
    write(
      path.join(proj, '.claude/skills/review/SKILL.md'),
      '---\nname: review-pr\ndescription: Review a PR\n---\nSteps',
    );
    write(
      path.join(proj, '.claude/skills/hidden/SKILL.md'),
      '---\ndescription: bg\nuser-invocable: false\n---\nx',
    );
    write(path.join(home, '.claude/skills/personal/SKILL.md'), '---\ndescription: mine\n---\nx');
    write(path.join(proj, '.claude/agents/helper.md'), '---\ndescription: helps\n---\nx');
    write(
      path.join(proj, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          gh: { command: 'npx', args: ['x'], env: { TOKEN: 'SECRET-123' } },
          web: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer SECRET-456' } },
        },
      }),
    );
    const d = discoverSlash('claude', path.join(proj, 'pkg'), home);
    const by = (n: string) => d.entries.find((e) => e.name === n);
    expect(by('frontend:component')).toMatchObject({
      kind: 'command',
      scope: 'project',
      description: 'Make a component',
      argumentHint: '[name]',
    });
    expect(by('deploy')?.description).toBe('Deploy it');
    expect(by('review-pr')).toMatchObject({ kind: 'skill', userInvocable: true });
    expect(by('hidden')?.userInvocable).toBe(false);
    expect(by('personal')).toMatchObject({ scope: 'user' });
    expect(by('helper')?.kind).toBe('agent');
    expect(by('gh')).toMatchObject({ kind: 'mcp', transport: 'stdio' });
    expect(by('web')).toMatchObject({ kind: 'mcp', transport: 'http' });
    const dump = JSON.stringify(d);
    expect(dump).not.toContain('SECRET');
    expect(dump).not.toContain(root); // 展示路径不暴露绝对路径
  });

  it('never reads credential / config files even if named like a skill file', () => {
    write(path.join(home, '.claude/skills/x/SKILL.md'), '---\ndescription: ok\n---\n');
    write(path.join(home, '.claude/.credentials.json'), '{"token":"SECRET"}');
    write(path.join(home, '.claude.json'), '{"mcpServers":{"leak":{}}}');
    const d = discoverSlash('claude', proj, home);
    expect(d.entries.map((e) => e.name)).toEqual(['x']);
  });

  it('discovers Codex .agents/skills and Grok skills / commands / plugins', () => {
    write(path.join(proj, '.agents/skills/lint/SKILL.md'), '---\ndescription: lint it\n---\nrun');
    write(path.join(home, '.agents/skills/mine/SKILL.md'), '---\ndescription: m\n---\nrun');
    const c = discoverSlash('codex', proj, home);
    expect(c.entries.map((e) => `${e.scope}:${e.name}`).sort()).toEqual([
      'project:lint',
      'user:mine',
    ]);

    write(
      path.join(proj, '.grok/skills/commit/SKILL.md'),
      '---\ndescription: c\nuser-invocable: true\n---\nx',
    );
    write(
      path.join(proj, '.grok/skills/yes/SKILL.md'),
      '---\ndescription: c\nuser-invocable: yes\n---\nx',
    );
    write(path.join(proj, '.grok/commands/ship.md'), 'Ship\n');
    write(
      path.join(proj, '.grok/plugins/acme/plugin.json'),
      '{"name":"acme","description":"Acme tools","secret":"S"}',
    );
    write(
      path.join(proj, '.grok/plugins/acme/skills/release/SKILL.md'),
      '---\ndescription: rel\n---\nx',
    );
    write(path.join(proj, '.grok/plugins/acme/commands/go.md'), 'go\n');
    write(
      path.join(proj, '.grok/plugins/acme/.mcp.json'),
      '{"mcpServers":{"lin":{"url":"https://l"}}}',
    );
    const g = discoverSlash('grok', proj, home);
    const by = (n: string) => g.entries.find((e) => e.name === n);
    expect(by('commit')?.userInvocable).toBe(true);
    expect(by('yes')?.userInvocable).toBe(false); // Grok：只有字面量 true 算
    expect(by('ship')?.kind).toBe('command');
    expect(by('acme')).toMatchObject({ kind: 'plugin', description: 'Acme tools' });
    expect(by('acme:release')).toMatchObject({ kind: 'skill', scope: 'plugin', plugin: 'acme' });
    expect(by('acme:go')?.kind).toBe('command');
    expect(by('lin')).toMatchObject({ kind: 'mcp', transport: 'http', plugin: 'acme' });
    expect(JSON.stringify(g)).not.toContain('"S"');

    write(
      path.join(home, '.grok/bundled/skills/review/SKILL.md'),
      '---\nname: review\ndescription: bundled review\nuser-invocable: true\n---\n',
    );
    write(
      path.join(home, '.grok/bundled/skills/docx/SKILL.md'),
      '---\nname: docx\ndescription: office\nuser-invocable: false\n---\n',
    );
    write(
      path.join(home, '.grok/skills/review/SKILL.md'),
      '---\nname: review\ndescription: mine\nuser-invocable: true\n---\n',
    );
    write(
      path.join(home, '.grok/bundled/workflows/deep-research.rhai'),
      'let meta = #{\n    name: "deep-research",\n    description: "Research a query",\n};\n',
    );
    write(
      path.join(proj, '.grok/workflows/survey.rhai'),
      'let meta = #{\n    name: "survey",\n    description: "Survey the repo",\n};\n',
    );
    const g2 = discoverSlash('grok', proj, home);
    const reviews = g2.entries.filter((e) => e.name === 'review');
    expect(reviews.map((e) => e.scope).sort()).toEqual(['bundled', 'user']);
    expect(g2.entries.find((e) => e.name === 'docx')?.userInvocable).toBe(false);
    expect(g2.entries.find((e) => e.id === 'bundled:workflow::deep-research')).toMatchObject({
      kind: 'command',
      scope: 'bundled',
      description: 'Research a query',
    });
    expect(g2.entries.find((e) => e.id === 'project:workflow::survey')).toMatchObject({
      description: 'Survey the repo',
      scope: 'project',
    });
    expect(expandSlash('grok', proj, 'project:workflow::survey', 'now', home)).toBeNull();
  });

  it('dsh / nomi have no public layout: nothing scanned', () => {
    write(path.join(proj, '.claude/commands/a.md'), 'x');
    expect(discoverSlash('dsh', proj, home)).toEqual({
      backend: 'dsh',
      entries: [],
      supported: false,
    });
  });

  it('expands templates by id only; arguments, indexes, named args, escapes, fallback append', () => {
    write(
      path.join(proj, '.claude/commands/fix.md'),
      '---\narguments: [issue, branch]\n---\nFix $issue on $branch ($0/$1) \\$5 all=$ARGUMENTS',
    );
    write(path.join(proj, '.claude/commands/plain.md'), 'Just do it');
    write(path.join(proj, '.claude/commands/inj.md'), 'Run:\n!`git status`\n');
    const e = expandSlash('claude', proj, 'project:command::fix', '12 "my branch"', home)!;
    expect(e.text).toBe('Fix 12 on my branch (12/my branch) $5 all=12 "my branch"');
    expect(expandSlash('claude', proj, 'project:command::plain', 'extra words', home)!.text).toBe(
      'Just do it\n\nARGUMENTS: extra words',
    );
    const inj = expandSlash('claude', proj, 'project:command::inj', '', home)!;
    expect(inj.shellInjection).toBe(true);
    expect(inj.text).toContain('!`git status`'); // 不执行，原样保留
    // 伪造的 id / 路径形式一律拒绝
    expect(expandSlash('claude', proj, '../../etc/passwd', '', home)).toBeNull();
    expect(expandSlash('claude', proj, 'project:command::nope', '', home)).toBeNull();
    expect(expandSlash('dsh', proj, 'project:command::fix', '', home)).toBeNull();
  });

  it('skill expansion carries a header with the skill directory', () => {
    write(path.join(proj, '.agents/skills/lint/SKILL.md'), '---\nname: lint\n---\nRun the linter.');
    const e = expandSlash('codex', proj, 'project:skill::lint', '', home)!;
    expect(e.text.startsWith('[Skill: lint — ')).toBe(true);
    expect(e.text).toContain('Run the linter.');
  });

  it('unmatched indexed placeholders stay literal; splitArgs handles quotes', () => {
    expect(expandTemplate('a $2 b', 'x').text).toBe('a $2 b');
    expect(splitArgs(`one "two words" 'three words' four`)).toEqual([
      'one',
      'two words',
      'three words',
      'four',
    ]);
  });

  it('caps the number of entries per directory', () => {
    for (let i = 0; i < 230; i++) write(path.join(proj, `.claude/commands/c${i}.md`), 'x');
    const d = discoverSlash('claude', proj, home);
    expect(d.entries.length).toBeLessThanOrEqual(200);
  });

  it('gitDiff reports status and diff for a real repo, and a clean error otherwise', async () => {
    const { execFileSync } = await import('node:child_process');
    const g = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...a], { cwd: proj });
    fs.rmSync(path.join(proj, '.git'), { recursive: true });
    g('init', '-q');
    write(path.join(proj, 'a.txt'), 'one\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'init');
    write(path.join(proj, 'a.txt'), 'two\n');
    const r = await gitDiff(proj);
    expect(r.ok).toBe(true);
    expect(r.status).toContain('a.txt');
    expect(r.diff).toContain('-one');
    expect(r.diff).toContain('+two');
    const bad = await gitDiff(path.join(root, 'nope'));
    expect(bad.ok).toBe(false);
  });
});
