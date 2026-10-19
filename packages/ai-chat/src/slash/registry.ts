/**
 * 注册表：合并各 adapter 的命令 → 解决重名 → 搜索 / 分组 → 执行。
 *
 * 重名规则：当前端优先于 Nomi 内置，同名时只留当前端的裸名。自定义命令重名时
 * 按 scopeOrder 先到先得，后来者改名为 `<scope>:<name>`（项目 → `project:x`，用户 → `user:x`）。
 */
import { t } from '@nomi-ai/ui';

import { rankItems, type Range } from '../utils/fuzzy';

import { disabledCard, errorCard, unknownCard } from './cards';
import { parseSlashInput } from './parse';
import {
  SLASH_SOURCE_ORDER,
  type SlashCommand,
  type SlashContext,
  type SlashKind,
  type SlashOutcome,
  type SlashSource,
} from './types';

type Scope = 'project' | 'user' | 'plugin' | 'bundled';

const FIXED_RANK: Partial<Record<SlashSource, number>> = {
  endpoint: 0,
  builtin: 1,
  ui: 2,
};

export function buildRegistry(
  commands: readonly SlashCommand[],
  scopeOrder: readonly Scope[] = ['project', 'user', 'plugin', 'bundled'],
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
  /** 谁占着这个（小写）名字：用来说明落选者为什么不能发 */
  const owner = new Map<string, SlashCommand>();
  const out: SlashCommand[] = [];
  const free = (n: string) => !taken.has(n.toLowerCase());
  for (const c of sorted) {
    let name = c.name;
    let qualified = false;
    let holder: SlashCommand | undefined;
    if (!free(name)) {
      const custom = FIXED_RANK[c.source] === undefined;
      if (!custom) continue; // 内置重复声明：丢弃后来者
      holder = owner.get(name.toLowerCase());
      const base = `${c.scope ?? 'project'}:${c.name}`;
      name = base;
      for (let n = 2; !free(name) && n < 20; n++) name = `${base}~${n}`;
      if (!free(name)) continue;
      qualified = true;
    }
    taken.add(name.toLowerCase());
    const item: SlashCommand = {
      ...c,
      id: qualified ? `${c.id}#${name}` : c.id,
      name,
      ...(qualified ? { qualified: true } : {}),
    };
    owner.set(name.toLowerCase(), item);
    // 限定名只存在于 Nomi 的菜单里。透传的命令发出去的是裸名，会变成执行占着裸名的那一条；
    // 内置自带的 bundled 项同理。CLI 没有指定落选者的语法，所以禁用并说明，绝不替它发裸名。
    // expand（Nomi 按 id 自己展开）不受影响：发出去的是展开后的正文，不是名字。
    if (qualified && (c.kind === 'passthrough' || c.scope === 'bundled')) {
      const reason = ambiguityReason(c.name, holder);
      out.push({
        ...item,
        disabled: { reason },
        run: () => ({ type: 'card', card: disabledCard(name, reason) }),
      });
      continue;
    }
    out.push(item);
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

const SCOPE_WORD: Record<string, () => string> = {
  project: () => t('项目'),
  user: () => t('用户'),
  plugin: () => t('插件'),
  bundled: () => t('自带'),
};

/** 落选的同名命令为什么不能发送（holder = 占着裸名的那一条） */
function ambiguityReason(bare: string, holder: SlashCommand | undefined): string {
  if (holder && FIXED_RANK[holder.source] !== undefined) {
    const who = holder.source === 'builtin' ? t('Nomi 内置') : t('CLI 自带');
    return t(
      '和{0}的 /{1} 重名。CLI 只认 /{1} 这个名字，没有指定这一条的写法，Nomi 不会替它发送，以免执行成别的命令。',
      who,
      bare,
    );
  }
  const scope = holder?.scope ? (SCOPE_WORD[holder.scope]?.() ?? holder.scope) : t('另一条');
  return t(
    '同名时 CLI 只会执行{0}版的 /{1}，没有指定其他版本的写法，Nomi 不会替它发送，以免执行成别的命令。',
    scope,
    bare,
  );
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

/**
 * 面板和 /help 只列出真正能用的命令。
 * `unsupported` 仍留在注册表里：打出来会被拦下，但不当成一条可选命令。
 */
export function offeredCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.filter((c) => c.kind !== 'unsupported');
}

/** 模糊搜索 + 分组。空查询返回全部可选项；组内按匹配分排序，完全相同的名字排最前 */
export function searchCommands(commands: readonly SlashCommand[], query: string): SlashGroup[] {
  const q = query.trim();
  const ranked = rankItems(offeredCommands(commands), q, (c) => [
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
  | { handled: true; outcome: SlashOutcome; command: string; name: string; kind?: SlashKind };

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
  if (c.disabled)
    return {
      handled: true,
      name: c.name,
      command: raw,
      outcome: { type: 'card', card: disabledCard(c.name, c.disabled.reason) },
    };
  try {
    return {
      handled: true,
      name: c.name,
      kind: c.kind,
      command: raw,
      outcome: await c.run(args, ctx),
    };
  } catch (e) {
    return {
      handled: true,
      name: c.name,
      command: raw,
      outcome: { type: 'card', card: errorCard(c.name, e) },
    };
  }
}
