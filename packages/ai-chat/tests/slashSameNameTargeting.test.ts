/**
 * issue #15：同名命令在菜单里被改成限定名（project:foo / user:foo），但透传的 run 仍发裸名，
 * 选中限定项实际执行的是另一条。这里锁定「实际发出去什么」：
 * - 优先项发裸名（与 CLI 自己的解析一致）
 * - 落选项（CLI 没有指定它的写法）禁用：不发送，给出说明
 * - Codex 由 Nomi 按 id 展开，每条都能精确执行
 * - 内置同名：内置仍占裸名，被改名的自定义项不能冒充 CLI 命令
 */
import { describe, expect, it } from 'vitest';

import { executeSlash, findCommand, flattenGroups, searchCommands } from '../src/slash/registry';
import type { SlashCommand, SlashOutcome } from '../src/slash/types';
import type { ConversationBackend } from '../src/types/chat';

import { entry, makeCtx } from './slashHelpers';

const sk = (name: string, scope: 'project' | 'user' | 'bundled' | 'plugin', kind = 'skill') =>
  entry({
    id: `${scope}:${kind}::${name}`,
    name,
    kind: kind as 'skill' | 'command',
    scope,
    description: `${scope} 版`,
  });

async function run(
  backend: ConversationBackend,
  input: string,
  discovered: ReturnType<typeof sk>[],
) {
  const { ctx, commands, actions } = makeCtx(backend, { discovered });
  const r = await executeSlash(input, commands, ctx);
  if (!r.handled) throw new Error('not handled');
  return { out: r.outcome as SlashOutcome, commands, actions };
}
const sent = (o: SlashOutcome) => (o.type === 'send' ? o.text : null);
const noticeOf = (o: SlashOutcome) => {
  if (o.type !== 'card') throw new Error(`expected card, got ${o.type}`);
  return o.card as { kind: string; title: string; text?: string; tone?: string };
};
/** 禁用项：不发送，且是说明卡片 */
function expectBlocked(o: SlashOutcome, name: string) {
  expect(sent(o)).toBeNull();
  const c = noticeOf(o);
  expect(c.kind).toBe('notice');
  expect(c.title).toContain(`/${name}`);
  expect(c.title).toContain('不能发送');
  expect(c.text).toMatch(/没有指定|不会替它发送/);
  return c;
}

describe('同名 project / user', () => {
  const both = [sk('foo', 'project'), sk('foo', 'user')];

  it('Claude：user 占裸名并正常发送；project 版禁用，说明原因，不发 /foo', async () => {
    const { commands, out } = await run('claude', '/foo a b', both);
    expect(sent(out)).toBe('/foo a b');
    expect(findCommand(commands, 'foo')).toMatchObject({ scope: 'user' });
    const loser = findCommand(commands, 'project:foo')!;
    expect(loser.qualified).toBe(true);
    expect(loser.disabled?.reason).toContain('用户版');
    const blocked = await run('claude', '/project:foo a b', both);
    expect(expectBlocked(blocked.out, 'project:foo').text).toContain('用户版');
    // 没有任何 send：连 expand 也没碰
    expect(blocked.actions.expand).not.toHaveBeenCalled();
  });

  it('Grok：project 占裸名；user 版禁用（暂不使用 Grok 的 /user: 限定写法）', async () => {
    const { out, commands } = await run('grok', '/foo', both);
    expect(sent(out)).toBe('/foo');
    expect(findCommand(commands, 'foo')).toMatchObject({ scope: 'project' });
    const blocked = await run('grok', '/user:foo', both);
    expect(expectBlocked(blocked.out, 'user:foo').text).toContain('项目版');
  });

  it('Codex：两条都由 Nomi 按各自 id 展开，不依赖名字', async () => {
    const { ctx, commands, actions } = makeCtx('codex', { discovered: both });
    actions.expand.mockResolvedValue({ text: '正文', shellInjection: false });
    expect(findCommand(commands, 'foo')!.disabled).toBeUndefined();
    expect(findCommand(commands, 'user:foo')!.disabled).toBeUndefined();
    await executeSlash('/foo x', commands, ctx);
    await executeSlash('/user:foo x', commands, ctx);
    expect(actions.expand.mock.calls).toEqual([
      ['project:skill::foo', 'x'],
      ['user:skill::foo', 'x'],
    ]);
  });

  it('禁用项的 run 本身也只给说明：绕过 executeSlash 直接调用也发不出裸名', async () => {
    const { ctx, commands } = makeCtx('claude', { discovered: both });
    const c = findCommand(commands, 'project:foo')!;
    const o = await c.run('x', ctx);
    expect(o.type).toBe('card');
  });

  it('命令文件与 skill 同作用域同名：落选的命令文件同样禁用', async () => {
    const d = [sk('x', 'project', 'skill'), sk('x', 'project', 'command')];
    const { commands } = await run('claude', '/x', d);
    expect(findCommand(commands, 'x')!.source).toBe('skill');
    expect(findCommand(commands, 'project:x')!.disabled).toBeTruthy();
  });

  it('三条同名：只有占裸名的那条可发送', async () => {
    const d = [sk('foo', 'project'), sk('foo', 'user'), sk('foo', 'plugin')];
    const { commands } = await run('claude', '/foo', d);
    const enabled = commands.filter((c) => c.name.includes('foo') && !c.disabled);
    expect(enabled.map((c) => c.name)).toEqual(['foo']);
  });
});

describe('同名 project / bundled（冲突时 bundled 一律禁用）', () => {
  const d = [sk('review2', 'bundled'), sk('review2', 'project')];
  for (const b of ['claude', 'grok', 'codex'] as const) {
    it(`${b}：project 占裸名，bundled 版不可发送`, async () => {
      const { commands, out, actions } = await run(b, '/review2', d);
      if (b === 'codex') expect(actions.expand).toHaveBeenCalledWith('project:skill::review2', '');
      else expect(sent(out)).toBe('/review2');
      const loser = findCommand(commands, 'bundled:review2')!;
      expect(loser.disabled).toBeTruthy();
      const blocked = await run(b, '/bundled:review2', d);
      expectBlocked(blocked.out, 'bundled:review2');
      if (b === 'codex') expect(blocked.actions.expand).not.toHaveBeenCalled();
    });
  }
});

describe('自定义与内置 / CLI 命令同名', () => {
  it('Claude：自定义 compact 被改名后禁用，/compact 仍是 CLI 自己的', async () => {
    const d = [sk('compact', 'project')];
    const base = await run('claude', '/compact', d);
    expect(sent(base.out)).toBe('/compact');
    expect(findCommand(base.commands, 'compact')!.source).toBe('endpoint');
    const blocked = await run('claude', '/project:compact', d);
    expect(expectBlocked(blocked.out, 'project:compact').text).toContain('CLI 自带');
  });

  it('Grok：自定义 context 不能冒充 Grok 的 /context；Nomi 内置 status 保持裸名', async () => {
    const d = [sk('context', 'user'), sk('status', 'project')];
    const ctxRun = await run('grok', '/context', d);
    expect(sent(ctxRun.out)).toBe('/context'); // Grok 自己的 /context
    expectBlocked((await run('grok', '/user:context', d)).out, 'user:context');
    const st = await run('grok', '/status', d);
    expect(noticeOf(st.out).kind).toBe('status'); // Nomi 内置卡片，不发给 CLI
    const blockedStatus = await run('grok', '/project:status', d);
    expect(expectBlocked(blockedStatus.out, 'project:status').text).toContain('Nomi 内置');
  });

  it('Claude：自定义 context 与 Nomi 内置重名 → 内置占裸名，自定义项禁用', async () => {
    const d = [sk('context', 'project', 'command')];
    const { commands, out } = await run('claude', '/context', d);
    expect(noticeOf(out).kind).toBe('context');
    expect(findCommand(commands, 'context')!.source).toBe('builtin');
    expect(findCommand(commands, 'project:context')!.disabled?.reason).toContain('Nomi 内置');
  });

  it('Codex：与内置同名的自定义 skill 改名后仍按 id 展开（发的是展开后的正文，不是名字）', async () => {
    const d = [sk('status', 'project')];
    const { ctx, commands, actions } = makeCtx('codex', { discovered: d });
    actions.expand.mockResolvedValue({ text: '展开正文', shellInjection: false });
    const st = await executeSlash('/status', commands, ctx);
    expect(st.handled && st.outcome.type).toBe('card');
    expect(actions.expand).not.toHaveBeenCalled();
    const r = await executeSlash('/project:status z', commands, ctx);
    expect(actions.expand).toHaveBeenCalledWith('project:skill::status', 'z');
    expect(r.handled && r.outcome).toMatchObject({ type: 'send', text: '展开正文' });
  });
});

describe('菜单与 /help：禁用项仍可见且标明不可用', () => {
  it('面板里保留，带 disabled 与原因；/help 列出并标「不可用」', async () => {
    const d = [sk('foo', 'project'), sk('foo', 'user')];
    const { commands, ctx } = makeCtx('claude', { discovered: d });
    const hits: SlashCommand[] = flattenGroups(searchCommands(commands, 'foo')).map(
      (h) => h.command,
    );
    expect(hits.map((c) => c.name).sort()).toEqual(['foo', 'project:foo']);
    expect(hits.find((c) => c.name === 'project:foo')!.disabled?.reason).toBeTruthy();
    const r = await executeSlash('/help', commands, ctx);
    const card = r.handled && r.outcome.type === 'card' ? r.outcome.card : null;
    const items = (card as { items: Array<{ label: string; badge?: string }> }).items;
    expect(items.find((i) => i.label === '/project:foo')!.badge).toBe('不可用');
    expect(items.find((i) => i.label === '/foo')!.badge).not.toBe('不可用');
  });
});
