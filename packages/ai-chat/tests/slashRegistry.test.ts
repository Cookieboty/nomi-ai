import { describe, expect, it } from 'vitest';

import {
  buildRegistry,
  executeSlash,
  findCommand,
  flattenGroups,
  searchCommands,
} from '../src/slash/registry';
import type { SlashCommand } from '../src/slash/types';

import { entry, makeCtx } from './slashHelpers';

const mk = (p: Partial<SlashCommand> & { name: string }): SlashCommand => ({
  id: `${p.source ?? 'builtin'}:${p.name}`,
  label: p.name,
  description: '',
  source: 'builtin',
  kind: 'native',
  run: () => ({ type: 'noop' }),
  ...p,
});

describe('buildRegistry 重名规则', () => {
  it('内置保留裸名，项目 / 用户命令改成限定名', () => {
    const r = buildRegistry([
      mk({ name: 'review', source: 'project', scope: 'project', kind: 'passthrough' }),
      mk({ name: 'review', source: 'builtin' }),
      mk({ name: 'review', source: 'user', scope: 'user', kind: 'passthrough' }),
    ]);
    expect(r.map((c) => c.name)).toEqual(['review', 'project:review', 'user:review']);
    expect(r[0]!.source).toBe('builtin');
    expect(r[1]!.qualified).toBe(true);
    expect(new Set(r.map((c) => c.id)).size).toBe(3);
  });
  it('自定义命令之间：Claude 个人优先，其它端项目优先', () => {
    const pj = mk({ name: 'deploy', source: 'project', scope: 'project', kind: 'passthrough' });
    const us = mk({ name: 'deploy', source: 'user', scope: 'user', kind: 'passthrough' });
    expect(buildRegistry([pj, us], ['user', 'project', 'plugin']).map((c) => c.name)).toEqual([
      'deploy',
      'project:deploy',
    ]);
    const a = buildRegistry([pj, us], ['project', 'user', 'plugin']);
    expect(a.find((c) => c.name === 'deploy')!.scope).toBe('project');
  });
  it('同作用域 skill 压过命令文件', () => {
    const cmdFile = mk({ name: 'x', source: 'project', scope: 'project', kind: 'passthrough' });
    const skill = mk({ name: 'x', source: 'skill', scope: 'project', kind: 'passthrough' });
    const r = buildRegistry([cmdFile, skill]);
    expect(r.find((c) => c.name === 'x')!.source).toBe('skill');
  });
  it('别名冲突被丢弃，不抢别人的名字', () => {
    const r = buildRegistry([
      mk({ name: 'cost', aliases: ['usage'] }),
      mk({ name: 'usage', source: 'endpoint' }),
    ]);
    expect(findCommand(r, 'usage')!.source).toBe('endpoint');
    expect(r.find((c) => c.name === 'cost')!.aliases ?? []).toEqual([]);
  });
  it('名字不区分大小写', () => {
    const r = buildRegistry([mk({ name: 'Context' })]);
    expect(findCommand(r, 'context')?.name).toBe('Context');
  });
});

describe('searchCommands', () => {
  const { commands } = makeCtx('claude', {
    discovered: [
      entry({ name: 'fix-issue', description: '修复 GitHub issue' }),
      entry({
        id: 'user:skill::pdf',
        name: 'pdf',
        kind: 'skill',
        scope: 'user',
        description: '处理 PDF',
      }),
    ],
  });
  it('空查询：按组顺序返回全部', () => {
    const g = searchCommands(commands, '');
    expect(g[0]!.source).toBe('builtin');
    expect(g.map((x) => x.source)).toEqual(
      expect.arrayContaining(['builtin', 'endpoint', 'project', 'skill']),
    );
    expect(flattenGroups(g).length).toBe(commands.length);
  });
  it('前缀 / 子序列 / 描述 / 别名都能命中', () => {
    const names = (q: string) =>
      flattenGroups(searchCommands(commands, q)).map((h) => h.command.name);
    expect(names('con')).toContain('context');
    expect(names('cnt')).toContain('context');
    expect(names('GitHub')).toContain('fix-issue');
    expect(names('usage')).toContain('cost');
    expect(names('zzzzqq')).toEqual([]);
  });
  it('完全同名排最前', () => {
    const flat = flattenGroups(searchCommands(commands, 'init'));
    expect(flat[0]!.command.name).toBe('init');
  });
  it('命中区间用于高亮', () => {
    const h = flattenGroups(searchCommands(commands, 'cont'))[0]!;
    expect(h.command.name).toBe('context');
    expect(h.ranges[0]).toEqual([0, 4]);
  });
});

describe('executeSlash', () => {
  it('普通文字 / 转义不处理', async () => {
    const { ctx, commands } = makeCtx('nomi');
    expect(await executeSlash('你好', commands, ctx)).toEqual({ handled: false });
    expect(await executeSlash('//help', commands, ctx)).toEqual({ handled: false, text: '/help' });
  });
  it('未知命令被拦下并给出「作为普通文字发送」', async () => {
    const { ctx, commands, actions } = makeCtx('nomi');
    const r = await executeSlash('/nope arg', commands, ctx);
    expect(r.handled).toBe(true);
    if (!r.handled || r.outcome.type !== 'card') throw new Error('expected card');
    expect(r.outcome.card.kind).toBe('notice');
    const send = r.outcome.card.actions?.[0];
    expect(send?.id).toBe('send-plain');
    await send!.run();
    expect(actions.sendPlain).toHaveBeenCalledWith('/nope arg');
  });
  it('命令抛错 → 错误卡片，不向外抛', async () => {
    const boom = mk({
      name: 'boom',
      run: () => {
        throw new Error('炸了');
      },
    });
    const { ctx } = makeCtx('nomi');
    const r = await executeSlash('/boom', [boom], ctx);
    expect(r.handled && r.outcome.type === 'card' && r.outcome.card.kind).toBe('notice');
  });
  it('别名可执行', async () => {
    const { ctx, commands } = makeCtx('nomi');
    const r = await executeSlash('/usage', commands, ctx);
    expect(r.handled && r.name).toBe('cost');
  });
});
