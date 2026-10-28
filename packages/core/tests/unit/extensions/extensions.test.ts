jest.unmock('path');

const path = jest.requireActual('path') as typeof import('path');

import {
  McpConfigError,
  maskServer,
  mergeSecrets,
  needsConfirm,
  parseImport,
  sanitizeServer,
} from '../../../src/extensions/mcpConfig';
import {
  SkillError,
  buildSkillMd,
  parseSkillMd,
  safeJoin,
  skillsContext,
} from '../../../src/extensions/skillPack';

describe('mcp config', () => {
  it('validates stdio and http servers', () => {
    const s = sanitizeServer({ name: 'Files', command: 'npx', args: ['-y', 'x'] });
    expect(s).toMatchObject({ id: 'files', transport: 'stdio', trust: 'ask', enabled: true });
    expect(() => sanitizeServer({ name: 'x' })).toThrow(McpConfigError);
    expect(sanitizeServer({ name: 'R', url: 'https://a.b/sse' }).transport).toBe('sse');
    expect(() => sanitizeServer({ name: 'R', transport: 'http', url: 'file:///etc' })).toThrow(
      'http',
    );
    expect(sanitizeServer({ name: '天气', command: 'x' }, new Set()).id).toBe('mcp');
  });
  it('imports mcpServers JSON with unique ids, disabled trust ask', () => {
    const list = parseImport(
      JSON.stringify({
        mcpServers: { files: { command: 'npx' }, remote: { url: 'https://x.y/mcp' } },
      }),
      ['files'],
    );
    expect(list.map((e) => e.id)).toEqual(['files-2', 'remote']);
    expect(list[1].transport).toBe('http');
    expect(() => parseImport('nope')).toThrow('JSON');
    expect(() => parseImport('{}')).toThrow('没有找到');
  });
  it('masks secrets and keeps old values on round trip', () => {
    const e = sanitizeServer({
      name: 'g',
      command: 'x',
      env: { GITHUB_TOKEN: 'ghp_abcdef', DEBUG: '1' },
    });
    const m = maskServer(e);
    expect(m.env).toEqual({ GITHUB_TOKEN: 'gh••••••', DEBUG: '1' });
    expect(mergeSecrets(m.env, e.env)).toEqual(e.env);
  });
  it('trust levels', () => {
    expect(needsConfirm('ask', true)).toBe(true);
    expect(needsConfirm('read-auto', true)).toBe(false);
    expect(needsConfirm('read-auto', false)).toBe(true);
    expect(needsConfirm('auto', false)).toBe(false);
  });
});

describe('skill packs', () => {
  it('parses and builds SKILL.md', () => {
    const md = buildSkillMd({ name: 'trip', description: '规划: 行程', version: '1.0' }, '# Hi');
    const p = parseSkillMd(md);
    expect(p.meta).toMatchObject({ name: 'trip', description: '规划: 行程', version: '1.0' });
    expect(p.body).toBe('# Hi');
    expect(() => parseSkillMd('# no front')).toThrow(SkillError);
    expect(() => parseSkillMd('---\nname: Bad Name\ndescription: x\n---\n')).toThrow('name');
    expect(() => parseSkillMd('---\nname: ok\n---\n')).toThrow('description');
  });
  it('blocks path traversal', () => {
    const root = path.resolve('/tmp/skill-root');
    expect(safeJoin(root, 'a/b.md')).toBe(path.join(root, 'a', 'b.md'));
    expect(() => safeJoin(root, '../x')).toThrow();
    expect(() => safeJoin(root, '/etc/passwd')).toThrow();
  });
  it('context lists only names and descriptions', () => {
    expect(skillsContext([])).toBe('');
    const c = skillsContext([{ name: 'a', description: 'd' }]);
    expect(c).toContain('skill_load');
    expect(c).toContain('- a：d');
  });
});
