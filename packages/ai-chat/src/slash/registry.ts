/**
 * 注册表：合并各 adapter 的命令 → 解决重名 → 搜索 / 分组 → 执行。
 *
 * 重名规则（设计见文档 §3.3）：内置 / 当前端 / 界面命令永远保留裸名；自定义命令重名时
 * 按 scopeOrder 先到先得，后来者改名为 `<scope>:<name>`（项目 → `project:x`，用户 → `user:x`）。
 */
import { rankItems, type Range } from '../utils/fuzzy';

import { errorCard, unknownCard } from './cards';
import { parseSlashInput } from './parse';
import {
  SLASH_SOURCE_ORDER,
  type SlashCommand,
  type SlashContext,
  type SlashOutcome,
  type SlashSource,
} from './types';

type Scope = 'project' | 'user' | 'plugin';

const FIXED_RANK: Partial<Record<SlashSource, number>> = {
  builtin: 0,
  endpoint: 1,
  ui: 2,
};

export function buildRegistry(
  commands: readonly SlashCommand[],
  scopeOrder: readonly Scope[] = ['project', 'user', 'plugin'],
): SlashCommand[] {
  const rank = (c: SlashCommand) => {
    const fixed = FIXED_RANK[c.source];
    if (fixed !== undefined) return fixed * 10;
    const sc = scopeOrder.indexOf((c.scope ?? 'project') as Scope);
    // 同一作用域里 skill 压过命令文件（Claude 文档）
    return 100 + (sc < 0 ? 9 : sc) * 2 + (c.source === 'skill' ? 0 : 1);
  };
  const sorted = commands
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);

  const taken = new Set<string>();
  const out: SlashCommand[] = [];
  const free = (n: string) => !taken.has(n.toLowerCase());
  for (const c of sorted) {
    let name = c.name;
    let qualified = false;
    if (!free(name)) {
      const custom = FIXED_RANK[c.source] === undefined;
      if (!custom) continue; // 内置重复声明：丢弃后来者
      const base = `${c.scope ?? 'project'}:${c.name}`;
      name = base;
      for (let n = 2; !free(name) && n < 20; n++) name = `${base}~${n}`;
      if (!free(name)) continue;
      qualified = true;
    }
    taken.add(name.toLowerCase());
    out.push({
      ...c,
      id: qualified ? `${c.id}#${name}` : c.id,
      name,
      ...(qualified ? { qualified: true } : {}),
    });
  }
  // 别名最后分配：真名永远优先于别名
  return out.map((c) => {
    if (!c.aliases) return c;
    const keep = c.aliases.filter((a) => {
      if (!free(a)) return false;
      taken.add(a.toLowerCase());
      return true;
    });
    const rest = { ...c };
    delete rest.aliases;
    return keep.length ? { ...rest, aliases: keep } : rest;
  });
}

export function findCommand(commands: readonly SlashCommand[], name: string): SlashCommand | null {
  const n = name.toLowerCase();
  return (
    commands.find((c) => c.name.toLowerCase() === n) ??
    commands.find((c) => c.aliases?.some((a) => a.toLowerCase() === n)) ??
    null
  );
}

export interface SlashHit {
  command: SlashCommand;
  ranges: Range[];
}
export interface SlashGroup {
  source: SlashSource;
  items: SlashHit[];
}

/** 模糊搜索 + 分组。空查询返回全部；组内按匹配分排序，完全相同的名字排最前 */
export function searchCommands(commands: readonly SlashCommand[], query: string): SlashGroup[] {
  const q = query.trim();
  const ranked = rankItems(commands, q, (c) => [
    { text: c.name, weight: 3, highlight: true },
    ...(c.aliases ?? []).map((a) => ({ text: a, weight: 2.5 })),
    { text: c.label, weight: 1.5 },
    { text: c.description, weight: 1 },
    ...(c.badge ? [{ text: c.badge, weight: 0.5 }] : []),
  ]);
  const lq = q.toLowerCase();
  const groups: SlashGroup[] = [];
  for (const source of SLASH_SOURCE_ORDER) {
    const items = ranked
      .filter((r) => r.item.source === source)
      .map((r) => ({ command: r.item, ranges: r.ranges }));
    if (lq)
      items.sort(
        (a, b) =>
          Number(b.command.name.toLowerCase() === lq) - Number(a.command.name.toLowerCase() === lq),
      );
    if (items.length) groups.push({ source, items });
  }
  // 有查询时，有完全同名的命令的组放最前，保证 Enter 选中用户敲全的那个
  if (lq)
    groups.sort(
      (a, b) =>
        Number(b.items[0]!.command.name.toLowerCase() === lq) -
        Number(a.items[0]!.command.name.toLowerCase() === lq),
    );
  return groups;
}

export const flattenGroups = (g: readonly SlashGroup[]): SlashHit[] => g.flatMap((x) => x.items);

export type ExecResult =
  | { handled: false; text?: string }
  | { handled: true; outcome: SlashOutcome; command: string; name: string };

/**
 * 执行一条输入：
 * - 不是命令 → handled:false（照常当文字发送）
 * - `//x` → handled:false，text 为去掉转义后的 `/x`
 * - 命中命令 → 运行；失败转成错误卡片
 * - 未知命令 → 拦下并给出卡片（不发给模型）
 */
export async function executeSlash(
  input: string,
  commands: readonly SlashCommand[],
  ctx: SlashContext,
): Promise<ExecResult> {
  const p = parseSlashInput(input);
  if (p.type === 'text') return { handled: false };
  if (p.type === 'escaped') return { handled: false, text: p.text };
  const { name, args, raw } = p.value;
  const c = findCommand(commands, name);
  if (!c)
    return {
      handled: true,
      name,
      command: raw,
      outcome: {
        type: 'card',
        card: unknownCard(name, commands, raw, ctx.actions.sendPlain),
      },
    };
  try {
    return { handled: true, name: c.name, command: raw, outcome: await c.run(args, ctx) };
  } catch (e) {
    return {
      handled: true,
      name: c.name,
      command: raw,
      outcome: { type: 'card', card: errorCard(c.name, e) },
    };
  }
}
