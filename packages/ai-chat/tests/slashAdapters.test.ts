import { describe, expect, it } from 'vitest';

import type { CliProviderState } from '../src/services/cliProviderClient';
import type { CliInstallInfo } from '../src/services/cliUpdateClient';
import type { ProviderState } from '../src/services/providerClient';
import { executeSlash, findCommand, flattenGroups, searchCommands } from '../src/slash/registry';

import { asst, entry, makeCtx, user } from './slashHelpers';

const run = async (
  backend: Parameters<typeof makeCtx>[0],
  input: string,
  over?: Parameters<typeof makeCtx>[1],
) => {
  const { ctx, commands, actions } = makeCtx(backend, over);
  const r = await executeSlash(input, commands, ctx);
  if (!r.handled) throw new Error('not handled');
  return { r, actions, ctx, commands };
};
const cardOf = (r: Awaited<ReturnType<typeof run>>['r']) => {
  if (!r.handled || r.outcome.type !== 'card') throw new Error('expected card');
  return r.outcome.card;
};

const custom = [
  entry({
    id: 'project:command::fix',
    name: 'fix',
    description: '修 bug',
    argumentHint: '[issue]',
  }),
  entry({ id: 'user:skill::pdf', name: 'pdf', kind: 'skill', scope: 'user' }),
  entry({ id: 'project:command::hidden', name: 'hidden', userInvocable: false }),
  entry({ id: 'project:mcp::git', name: 'git', kind: 'mcp', transport: 'stdio' }),
];

describe('各端命令集', () => {
  it('每个端都有 Nomi 原生命令', () => {
    for (const b of ['nomi', 'claude', 'codex', 'grok', 'dsh'] as const) {
      const { commands } = makeCtx(b);
      for (const n of ['help', 'context', 'cost', 'status', 'model', 'clear', 'plugins'])
        expect(findCommand(commands, n), `${b}:${n}`).toBeTruthy();
      expect(!!findCommand(commands, 'diff')).toBe(b !== 'nomi');
    }
    // Grok 的 /context 由 CLI 自己执行，其它端仍是 Nomi 卡片
    expect(findCommand(makeCtx('grok').commands, 'context')!.kind).toBe('passthrough');
    for (const b of ['nomi', 'claude', 'codex', 'dsh'] as const)
      expect(findCommand(makeCtx(b).commands, 'context')!.kind).toBe('native');
  });
  it('Claude：官方非交互命令透传，review 别名可用', async () => {
    const { r } = await run('claude', '/code-review 看看 auth');
    expect(r.handled && r.outcome).toEqual({ type: 'send', text: '/code-review 看看 auth' });
    const { r: r2 } = await run('claude', '/review');
    expect(r2.handled && r2.outcome).toEqual({ type: 'send', text: '/code-review' });
    const { r: r3 } = await run('claude', '/compact');
    expect(r3.handled && r3.outcome).toEqual({ type: 'send', text: '/compact' });
  });
  it('Claude：自定义命令 / skill 原样透传；不可调用的、MCP 不出现', async () => {
    const { commands, r } = await run('claude', '/fix 123', { discovered: custom });
    expect(r.handled && r.outcome).toEqual({ type: 'send', text: '/fix 123' });
    expect(findCommand(commands, 'pdf')!.source).toBe('skill');
    expect(findCommand(commands, 'hidden')).toBeNull();
    expect(findCommand(commands, 'git')).toBeNull();
    expect(findCommand(commands, 'fix')!.args?.hint).toBe('[issue]');
  });
  it('Claude 自定义命令与内置重名时被改成限定名', async () => {
    const { commands } = makeCtx('claude', {
      discovered: [entry({ id: 'project:command::status', name: 'status' })],
    });
    expect(findCommand(commands, 'status')!.source).toBe('builtin');
    expect(findCommand(commands, 'project:status')!.qualified).toBe(true);
    // 透传项被改名后不能再发裸名 /status（那会执行成别的命令）：禁用
    expect(findCommand(commands, 'project:status')!.disabled?.reason).toContain('Nomi 内置');
  });
  it('Codex：自定义命令由主进程按 id 展开后发送', async () => {
    const { ctx, commands, actions } = makeCtx('codex', { discovered: custom });
    actions.expand.mockResolvedValueOnce({ text: '展开后的提示词 123', shellInjection: true });
    const r = await executeSlash('/fix 123', commands, ctx);
    expect(actions.expand).toHaveBeenCalledWith('project:command::fix', '123');
    expect(r.handled && r.outcome).toMatchObject({ type: 'send', text: '展开后的提示词 123' });
    expect(r.handled && r.outcome.type === 'send' && r.outcome.note).toBeTruthy();
  });
  it('Grok：自定义命令和 skill 原样发给 Grok，不在本地展开', async () => {
    const { ctx, commands, actions } = makeCtx('grok', { discovered: custom });
    const r = await executeSlash('/fix 123', commands, ctx);
    expect(actions.expand).not.toHaveBeenCalled();
    expect(r.handled && r.outcome).toEqual({ type: 'send', text: '/fix 123' });
    expect(findCommand(commands, 'pdf')!.kind).toBe('passthrough');
  });
  it('展开失败（文件已删除）→ 提示卡片，不发送', async () => {
    const { r } = await run('codex', '/fix', { discovered: custom });
    expect(cardOf(r).kind).toBe('notice');
  });
  it('dsh 不扫描目录，也没有透传命令', () => {
    const { commands } = makeCtx('dsh', { discovered: custom });
    expect(findCommand(commands, 'fix')).toBeNull();
    expect(commands.some((c) => c.kind === 'passthrough')).toBe(false);
  });
  it('Codex / dsh 不把 /review /init /compact 做成 Nomi 命令', async () => {
    for (const b of ['codex', 'dsh'] as const) {
      const { commands } = makeCtx(b);
      const shown = flattenGroups(searchCommands(commands, '')).map((h) => h.command.name);
      for (const n of ['review', 'init', 'compact'] as const) {
        expect(shown, `${b}:${n}`).not.toContain(n);
        expect(findCommand(commands, n)!.kind).toBe('unsupported');
      }
      const { r } = await run(b, '/review 并发问题');
      const c = cardOf(r);
      expect(c.kind).toBe('notice');
      expect(c.kind === 'notice' && c.title).toContain('review');
    }
  });
  it('Grok：无头模式能跑的命令原样发送，分页器命令仍然拦下', async () => {
    const { commands } = makeCtx('grok');
    const shown = flattenGroups(searchCommands(commands, '')).map((h) => h.command.name);
    for (const n of [
      'compact',
      'context',
      'always-approve',
      'session-info',
      'feedback',
      'deep-research',
      'workflow',
      'goal',
      'loop',
    ]) {
      expect(shown, n).toContain(n);
      expect(findCommand(commands, n), n).toMatchObject({
        kind: 'passthrough',
        source: 'endpoint',
        badge: 'Grok',
      });
    }
    expect(shown).not.toContain('init');
    expect(findCommand(commands, 'init')!.kind).toBe('unsupported');
    expect(findCommand(commands, 'status')!.kind).toBe('native');
    expect(findCommand(commands, 'feedback')!.kind).toBe('passthrough');
    const sent = await run('grok', '/compact');
    expect(sent.r.handled && sent.r.outcome).toEqual({ type: 'send', text: '/compact' });
    const researched = await run('grok', '/deep-research postgres');
    expect(researched.r.handled && researched.r.outcome).toEqual({
      type: 'send',
      text: '/deep-research postgres',
    });
    const listed = await run('grok', '/workflow list');
    expect(listed.r.handled && listed.r.outcome).toEqual({ type: 'send', text: '/workflow list' });
    const blocked = await run('grok', '/init');
    expect(cardOf(blocked.r).kind).toBe('notice');
  });
  it('Grok：项目 skill 压过同名的自带 skill，两条都留在菜单里', () => {
    const { commands } = makeCtx('grok', {
      discovered: [
        entry({
          id: 'bundled:skill::review',
          name: 'review',
          kind: 'skill',
          scope: 'bundled',
          description: '自带',
        }),
        entry({
          id: 'project:skill::review',
          name: 'review',
          kind: 'skill',
          scope: 'project',
          description: '项目',
        }),
      ],
    });
    expect(findCommand(commands, 'review')).toMatchObject({
      scope: 'project',
      kind: 'passthrough',
      description: '项目',
    });
    // 自带版落选：CLI 没有指定它的写法，菜单里保留但禁用（不会替它发 /review）
    expect(findCommand(commands, 'bundled:review')).toMatchObject({
      scope: 'bundled',
      kind: 'passthrough',
      qualified: true,
      disabled: { reason: expect.stringContaining('项目版') },
    });
  });
  it('Claude 的 /compact 是 CLI 命令，不是 Nomi 内置', () => {
    const { commands } = makeCtx('claude');
    const hit = flattenGroups(searchCommands(commands, 'compact'))[0]!;
    expect(hit.command.kind).toBe('passthrough');
    expect(hit.command.source).toBe('endpoint');
    expect(hit.command.badge).toBe('Claude Code');
  });
  it('不支持的命令：说明原因 + 替代方案，不发送', async () => {
    for (const [b, n] of [
      ['claude', 'memory'],
      ['claude', 'login'],
      ['codex', 'compact'],
      ['codex', 'permissions'],
      ['grok', 'mention'],
      ['nomi', 'compact'],
    ] as const) {
      const { r } = await run(b, `/${n}`);
      const c = cardOf(r);
      expect(c.kind, `${b}:${n}`).toBe('notice');
      expect(c.kind === 'notice' && c.tone).toBe('warn');
    }
  });
  it('/clear 与 /new 都触发新会话，不发给模型', async () => {
    const a = await run('codex', '/new');
    expect(a.actions.newSession).toHaveBeenCalledTimes(1);
    expect(a.r.handled && a.r.outcome.type).toBe('noop');
  });
  it('/plugins 及别名打开面板', async () => {
    for (const n of ['plugins', 'skills', 'mcp', 'agents']) {
      const a = await run('claude', `/${n}`);
      expect(a.actions.openPlugins).toHaveBeenCalled();
    }
  });
  it('Nomi 自带 Skills：展开技能正文', async () => {
    const { ctx, commands, actions } = makeCtx('nomi');
    // 通过 adapter 输入带上 skills
    const { adapterFor } = await import('../src/slash/adapters');
    const { buildRegistry } = await import('../src/slash/registry');
    const cmds = buildRegistry(
      adapterFor('nomi', {
        backend: 'nomi',
        discovered: null,
        nomiSkills: [{ name: 'translate', description: '翻译' }],
      }),
    );
    actions.nomiSkillBody.mockResolvedValueOnce('把文字翻成英文');
    const r = await executeSlash('/translate 你好', cmds, { ...ctx, commands: () => cmds });
    expect(commands.length).toBeLessThan(cmds.length);
    const o = r.handled && r.outcome;
    expect(o && o.type === 'send' && o.text).toContain('把文字翻成英文');
    expect(o && o.type === 'send' && o.text).toContain('你好');
  });
});

describe('/help /diff', () => {
  it('/help 列出本端命令，并标注接管方式', async () => {
    const { r } = await run('claude', '/help');
    const c = cardOf(r);
    if (c.kind !== 'list') throw new Error('list');
    const names = c.items.map((i) => i.label);
    expect(names).toEqual(expect.arrayContaining(['/context', '/compact']));
    expect(names.indexOf('/compact')).toBeLessThan(names.indexOf('/context'));
    expect(names).not.toContain('/memory');
    expect(c.items.find((i) => i.label === '/compact')!.badge).toBe('转给 CLI');
  });
  it('/diff 走只读 gitDiff', async () => {
    const { r, actions } = await run('claude', '/diff');
    expect(actions.gitDiff).toHaveBeenCalled();
    expect(cardOf(r).kind).toBe('diff');
  });
});

describe('/model', () => {
  const cli = (): CliProviderState =>
    ({
      profiles: [
        { id: 'p1', kind: 'claude', name: 'GLM', model: 'glm-4.6', active: true },
        { id: 'p2', kind: 'claude', name: 'Kimi', model: 'kimi-k2', active: false },
        { id: 'p3', kind: 'codex', name: 'Other', model: 'o3', active: false },
      ],
    }) as unknown as CliProviderState;
  const nomi = (): ProviderState =>
    ({
      providers: [
        {
          id: 'a',
          name: 'OpenAI',
          enabled: true,
          defaultModel: 'gpt-5',
          models: ['gpt-5', 'gpt-5-mini'],
        },
        { id: 'b', name: 'Off', enabled: false, defaultModel: 'x', models: ['x'] },
      ],
      envProviders: [],
      effectiveProviderId: 'a',
      effectiveModel: 'gpt-5',
    }) as unknown as ProviderState;

  it('CLI：只列这个端的档案 + 默认项，标出当前', async () => {
    const { r } = await run('claude', '/model', { data: { cliProviders: cli() } });
    const c = cardOf(r);
    if (c.kind !== 'list') throw new Error('list');
    expect(c.items.map((i) => i.label)).toEqual([
      expect.stringContaining('CLI'),
      'GLM · glm-4.6',
      'Kimi · kimi-k2',
    ]);
    expect(c.items.filter((i) => i.active).map((i) => i.label)).toEqual(['GLM · glm-4.6']);
  });
  it('CLI：/model kimi 唯一命中 → 直接激活档案', async () => {
    const { r, actions } = await run('claude', '/model kimi', { data: { cliProviders: cli() } });
    expect(actions.activateCliProfile).toHaveBeenCalledWith('p2');
    expect(cardOf(r).kind).toBe('notice');
  });
  it('Nomi：只列启用的供应商；/model gpt-5-mini 直接切换', async () => {
    const { r, actions } = await run('nomi', '/model gpt-5-mini', {
      data: { nomiProviders: nomi() },
    });
    expect(actions.switchNomiModel).toHaveBeenCalledWith('a', 'gpt-5-mini');
    expect(cardOf(r).title).toContain('切换');
    const l = await run('nomi', '/model', { data: { nomiProviders: nomi() } });
    const c = cardOf(l.r);
    expect(c.kind === 'list' && c.items.length).toBe(2);
  });
  it('多个命中 → 只列表不切换；切换失败 → 错误卡片', async () => {
    const m = await run('nomi', '/model gpt', { data: { nomiProviders: nomi() } });
    expect(m.actions.switchNomiModel).not.toHaveBeenCalled();
    expect(cardOf(m.r).kind).toBe('list');
    const { ctx, commands, actions } = makeCtx('claude', { data: { cliProviders: cli() } });
    actions.activateCliProfile.mockResolvedValueOnce({ ok: false, error: '写入失败' } as never);
    const r = await executeSlash('/model kimi', commands, ctx);
    const c = r.handled && r.outcome.type === 'card' ? r.outcome.card : null;
    expect(c?.kind === 'notice' && c.tone).toBe('error');
  });
});

describe('/status /context /cost', () => {
  const cli: CliInstallInfo = { kind: 'claude', version: '2.1.5' } as CliInstallInfo;
  it('/status：端、模型、供应商、目录、版本、登录方式', async () => {
    const { r } = await run('claude', '/status', {
      data: {
        cli,
        quota: {
          id: 'claude',
          label: 'Claude',
          status: 'ok',
          auth: 'subscription',
          windows: [],
          plan: 'Max',
        },
      },
    });
    const c = cardOf(r);
    if (c.kind !== 'status') throw new Error('status');
    const row = (l: string) => c.rows.find((x) => x.label === l)?.value;
    expect(row('端')).toBe('Claude Code');
    expect(row('工作目录')).toBe('/work/app');
    expect(row('CLI 版本')).toBe('2.1.5');
    expect(row('登录方式')).toContain('账号');
    expect(row('套餐')).toBe('Max');
    expect(row('会话')).toBe('abcdef12');
  });
  it('/status 不含凭据类字段', async () => {
    const { r } = await run('codex', '/status');
    const c = cardOf(r);
    expect(JSON.stringify(c)).not.toMatch(/key|token|secret/i);
  });
  it('/context：优先真实用量，分类为估算，窗口来自对照表', async () => {
    const msgs = [
      user('1', '你好'.repeat(50)),
      asst('2', 'x'.repeat(400), { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 }),
      user('3', '后面的提问'),
    ];
    const { r } = await run('claude', '/context', {
      messages: msgs,
      data: {
        cliProviders: {
          profiles: [
            { id: 'p', kind: 'claude', name: 'X', model: 'claude-sonnet-4-5', active: true },
          ],
        } as unknown as CliProviderState,
      },
    });
    const c = cardOf(r);
    if (c.kind !== 'context') throw new Error('context');
    expect(c.basis).toBe('actual');
    expect(c.used).toBeGreaterThanOrEqual(10_500);
    expect(c.windowSize).toBe(200_000);
    expect(c.windowSource).toBe('table');
    expect(c.categories.some((x) => x.key === 'system')).toBe(true);
    expect(c.notes.length).toBeGreaterThan(1);
  });
  it('/context：无用量时全部估算，未知模型用默认窗口', async () => {
    const { r } = await run('nomi', '/context', { messages: [user('1', 'hello world')] });
    const c = cardOf(r);
    if (c.kind !== 'context') throw new Error('context');
    expect(c.basis).toBe('estimate');
    expect(c.windowSource).toBe('default');
    expect(c.used).toBeGreaterThan(0);
  });
  it('/cost：会话合计 + 缺失轮数 + 今日 / 近 7 天', async () => {
    const { r } = await run('codex', '/cost', {
      messages: [
        user('1', 'a'),
        asst('2', 'b', { inputTokens: 100, outputTokens: 50, costUsd: 0.02 }),
        asst('3', 'c'),
      ],
      data: {
        usage: {
          today: { costUsd: 1.5, total: 1000, calls: 3 },
          week: { costUsd: 9, total: 9000, calls: 20 },
        } as never,
      },
    });
    const c = cardOf(r);
    if (c.kind !== 'cost') throw new Error('cost');
    expect(c.session).toMatchObject({ turns: 2, input: 100, output: 50, missing: 1 });
    expect(c.session.costUsd).toBeCloseTo(0.02);
    expect(c.today?.calls).toBe(3);
    expect(c.week?.costUsd).toBe(9);
    expect(c.notes.length).toBeGreaterThan(0);
  });
});
