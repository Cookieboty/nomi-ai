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
    // 不在任何 git 仓库里时只有自己；临时目录本身落在某个仓库里（turbo 下 TMPDIR 在本仓库 .tmp/ 里）
    // 时应一直走到那个仓库的根并停下，不再往上
    const h = path.join(root, 'home');
    const up: string[] = [];
    let gitRoot: string | null = null;
    for (let d = path.dirname(h); d !== path.dirname(d); d = path.dirname(d)) {
      up.push(d);
      if (fs.existsSync(path.join(d, '.git'))) {
        gitRoot = d;
        break;
      }
    }
    expect(projectChain(h)).toEqual(gitRoot ? [h, ...up] : [h]);
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

  describe('符号链接不能绕过凭据拒读（#16）', () => {
    const SECRET = 'SYNTHETIC_SECRET_VALUE_9f3a';
    const itPosix = process.platform === 'win32' ? it.skip : it;
    const link = (target: string, at: string) => {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.symlinkSync(target, at);
    };
    const noLeak = (backend: 'claude' | 'codex', id?: string) => {
      const d = discoverSlash(backend, proj, home);
      expect(JSON.stringify(d)).not.toContain(SECRET);
      if (id) {
        const x = expandSlash(backend, proj, id, '', home);
        expect(x === null || !x.text.includes(SECRET)).toBe(true);
      }
      return d;
    };

    itPosix('叶子 SKILL.md → 项目 .env：不进发现结果，描述与展开都不含密钥', () => {
      write(path.join(proj, '.env'), `${SECRET}\n`);
      link(path.join(proj, '.env'), path.join(proj, '.agents/skills/evil/SKILL.md'));
      const d = noLeak('codex', 'project:skill::evil');
      expect(d.entries.map((e) => e.name)).not.toContain('evil');
      expect(expandSlash('codex', proj, 'project:skill::evil', '', home)).toBeNull();
    });

    itPosix('叶子 SKILL.md → auth.json / *.pem / ~/.ssh/id_rsa / .git/config 均被拒', () => {
      write(path.join(proj, 'auth.json'), SECRET);
      write(path.join(proj, 'k.pem'), SECRET);
      write(path.join(proj, '.git/config'), `[remote "o"]\n url = https://${SECRET}@h/x\n`);
      write(path.join(home, '.ssh/id_rsa'), SECRET);
      link(path.join(proj, 'auth.json'), path.join(proj, '.agents/skills/a/SKILL.md'));
      link(path.join(proj, 'k.pem'), path.join(proj, '.agents/skills/b/SKILL.md'));
      link(path.join(proj, '.git/config'), path.join(proj, '.agents/skills/c/SKILL.md'));
      link(path.join(home, '.ssh/id_rsa'), path.join(proj, '.agents/skills/d/SKILL.md'));
      const d = noLeak('codex');
      expect(d.entries).toEqual([]);
    });

    itPosix(
      '父目录链接：skill 目录 → 项目外目录 / ~/.ssh 类目录，目标里的 SKILL.md 不被读取',
      () => {
        write(path.join(root, 'outside/SKILL.md'), `${SECRET}\n`);
        write(path.join(home, '.aws/SKILL.md'), `${SECRET}\n`);
        link(path.join(root, 'outside'), path.join(proj, '.claude/skills/out'));
        link(path.join(home, '.aws'), path.join(proj, '.claude/skills/aws'));
        const d = noLeak('claude', 'project:skill::out');
        expect(d.entries).toEqual([]);
      },
    );

    itPosix('用户目录里的 skill 也不能链接到凭据文件', () => {
      write(path.join(home, '.env'), SECRET);
      link(path.join(home, '.env'), path.join(home, '.agents/skills/u/SKILL.md'));
      const d = noLeak('codex', 'user:skill::u');
      expect(d.entries).toEqual([]);
    });

    itPosix('合法共享 skill 仍可用：用户目录链到别处、项目内链接、项目链到用户 agent 目录', () => {
      write(path.join(root, 'shared/one/SKILL.md'), '---\ndescription: shared one\n---\nbody one');
      link(path.join(root, 'shared/one'), path.join(home, '.agents/skills/one'));
      write(path.join(proj, 'tools/two/SKILL.md'), '---\ndescription: two\n---\nbody two');
      link(path.join(proj, 'tools/two'), path.join(proj, '.agents/skills/two'));
      write(path.join(home, '.agents/skills/common/SKILL.md'), '---\ndescription: c\n---\nbody c');
      link(path.join(home, '.agents/skills/common'), path.join(proj, '.agents/skills/common2'));
      const d = discoverSlash('codex', proj, home);
      expect(d.entries.map((e) => `${e.scope}:${e.name}`).sort()).toEqual([
        'project:common2',
        'project:two',
        'user:common',
        'user:one',
      ]);
      expect(expandSlash('codex', proj, 'user:skill::one', '', home)?.text).toContain('body one');
      expect(expandSlash('codex', proj, 'project:skill::two', '', home)?.text).toContain(
        'body two',
      );
    });

    itPosix(
      '项目 skill 不能链到 ~/.claude 的会话历史 / 会话记录 / 配置（只允许内容子目录）',
      () => {
        write(path.join(home, '.claude/history.jsonl'), `{"display":"${SECRET}"}\n`);
        write(path.join(home, '.claude/projects/p/s.jsonl'), `{"m":"${SECRET}"}\n`);
        write(path.join(home, '.claude/config.json'), `{"k":"${SECRET}"}`);
        // 扩展名一致、但不在内容子目录里的 .md 也不行
        write(
          path.join(home, '.claude/projects/p/notes.md'),
          `---\ndescription: n\n---\n${SECRET}`,
        );
        link(
          path.join(home, '.claude/history.jsonl'),
          path.join(proj, '.claude/skills/h/SKILL.md'),
        );
        link(
          path.join(home, '.claude/projects/p/s.jsonl'),
          path.join(proj, '.claude/commands/s.md'),
        );
        link(path.join(home, '.claude/config.json'), path.join(proj, '.claude/agents/c.md'));
        link(
          path.join(home, '.claude/projects/p/notes.md'),
          path.join(proj, '.claude/skills/n/SKILL.md'),
        );
        link(path.join(home, '.claude/projects'), path.join(proj, '.claude/skills/dir'));
        const d = noLeak('claude', 'project:skill::n');
        expect(d.entries).toEqual([]);
        expect(expandSlash('claude', proj, 'project:command::s', '', home)).toBeNull();
      },
    );

    itPosix('链接不能改变文件类型；同扩展名的常见密钥文件名一律拒读', () => {
      write(path.join(proj, 'notes.txt'), `---\ndescription: t\n---\n${SECRET}`);
      link(path.join(proj, 'notes.txt'), path.join(proj, '.agents/skills/t/SKILL.md'));
      write(path.join(proj, '.agents/skills/ok/SKILL.md'), '---\ndescription: ok\n---\nfine');
      expect(noLeak('codex', 'project:skill::t').entries.map((e) => e.name)).toEqual(['ok']);
      // plugin.json → 同为 .json 的服务账号密钥：扩展名规则拦不住，靠文件名拒读
      const manifest = JSON.stringify({ name: 'evil', description: SECRET });
      for (const name of ['service-account.json', 'secrets.json', 'prod.tfvars.json']) {
        write(path.join(proj, 'deploy', name), manifest);
        link(path.join(proj, 'deploy', name), path.join(proj, `.grok/plugins/${name}/plugin.json`));
      }
      const g = discoverSlash('grok', proj, home);
      expect(JSON.stringify(g)).not.toContain(SECRET);
    });

    itPosix('发现之后 SKILL.md 被换成指向凭据的链接：展开时重新校验，不外发', () => {
      write(path.join(proj, '.agents/skills/swap/SKILL.md'), '---\ndescription: ok\n---\nfine');
      write(path.join(proj, '.env'), SECRET);
      expect(discoverSlash('codex', proj, home).entries.map((e) => e.name)).toContain('swap');
      fs.rmSync(path.join(proj, '.agents/skills/swap/SKILL.md'));
      link(path.join(proj, '.env'), path.join(proj, '.agents/skills/swap/SKILL.md'));
      expect(expandSlash('codex', proj, 'project:skill::swap', '', home)).toBeNull();
    });
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
