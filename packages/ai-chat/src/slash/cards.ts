/**
 * 原生命令的结果卡片构造（纯函数：输入数据 → 卡片内容）。
 * 卡片显示在会话流里，不发给模型。
 */
import { t } from '@nomi-ai/ui';

import type { BackendModelCatalog } from '../services/harnessClient';
import { nomiModelChoices, splitRef } from '../services/nomiModel';
import { providerDisplayName } from '../services/providerClient';
import { ENDPOINT_FULL } from '../utils/endpointBadge';
import { rankItems } from '../utils/fuzzy';

import { contextWindowFor, estimateContext } from './tokens';
import type {
  CardAction,
  CardListItem,
  CardRow,
  SlashCardInput,
  SlashCommand,
  SlashContext,
  SlashData,
  SlashKind,
} from './types';
import { SLASH_SOURCE_ORDER } from './types';

export const notice = (
  title: string,
  text: string,
  tone: 'info' | 'warn' | 'error' = 'info',
  extra?: { detail?: string; actions?: CardAction[] },
): SlashCardInput => ({
  kind: 'notice',
  title,
  tone,
  text,
  ...(extra?.detail ? { detail: extra.detail } : {}),
  ...(extra?.actions ? { actions: extra.actions } : {}),
});

// ───────────────────────── 当前模型 / 供应商 ─────────────────────────

export interface ModelInfo {
  model?: string;
  provider?: string;
  /** 来自 Nomi 里启用的 CLI 供应商 */
  profile: boolean;
}

export function currentModel(ctx: SlashContext, data: SlashData): ModelInfo {
  if (ctx.backend === 'nomi') {
    const gw = data.nomiGateway;
    const main = gw?.clients.nomi?.models.main;
    const r = main ? splitRef(main) : null;
    if (r) {
      const p = gw!.providers.find((x) => x.id === r.provider);
      return {
        model: r.model,
        provider: p ? providerDisplayName(p.name) : r.provider,
        profile: false,
      };
    }
    // 网关里还没分配：旧存储（环境变量供应商等）
    const np = data.nomiProviders;
    const id = np?.effectiveProviderId;
    const prov = np?.providers.find((p) => p.id === id);
    const env = np?.envProviders.find((p) => p.id === id);
    return {
      model: np?.effectiveModel,
      provider: prov?.name ?? env?.name,
      profile: false,
    };
  }
  const active = data.cliProviders?.profiles.find((p) => p.kind === ctx.backend && p.active);
  if (active) {
    const model = active.model && active.model !== 'unknown' ? active.model : undefined;
    return { ...(model ? { model } : {}), provider: active.name, profile: true };
  }
  const used = data.usage?.byModel?.find((r) => r.key && r.key !== 'unknown')?.key;
  return { ...(used ? { model: used } : {}), profile: false };
}

// ───────────────────────────── /context ─────────────────────────────

export function contextCard(ctx: SlashContext, data: SlashData): SlashCardInput {
  const m = currentModel(ctx, data);
  const win = contextWindowFor(m.model);
  const est = estimateContext(ctx.messages, {
    user: t('你的消息'),
    assistant: t('助手回复'),
    tools: t('工具调用与结果'),
    thinking: t('思考'),
    system: t('系统提示 / 工具定义 / 记忆（推算）'),
  });
  const notes: string[] = [];
  notes.push(
    est.basis === 'actual'
      ? t('总量取自最近一次请求返回的真实用量；各类占比是按文字估算的。')
      : t('这个会话还没有真实用量记录，总量和各类占比都是估算。'),
  );
  notes.push(
    win.source === 'table'
      ? t('窗口大小来自内置的常见模型对照表，可能与实际不符。')
      : t('无法识别当前模型的窗口大小，暂按 128K 估算。'),
  );
  if (ctx.backend !== 'nomi')
    notes.push(t('这是 Nomi 按会话记录做的统计，和 CLI 内部的统计（含自动压缩）可能不同。'));
  return {
    kind: 'context',
    title: t('上下文用量'),
    used: est.used,
    windowSize: win.size,
    windowSource: win.source,
    basis: est.basis,
    categories: est.categories,
    ...(m.model ? { model: m.model } : {}),
    notes,
  };
}

// ───────────────────────────── /cost ─────────────────────────────

export function costCard(ctx: SlashContext, data: SlashData): SlashCardInput {
  const s = { turns: 0, input: 0, output: 0, cacheRead: 0, costUsd: 0, missing: 0 };
  for (const m of ctx.messages) {
    if (m.role !== 'assistant') continue;
    s.turns++;
    const u = m.usage;
    if (!u || (!u.inputTokens && !u.outputTokens && !u.costUsd)) {
      s.missing++;
      continue;
    }
    s.input += u.inputTokens ?? 0;
    s.output += u.outputTokens ?? 0;
    s.cacheRead += u.cacheReadTokens ?? 0;
    s.costUsd += u.costUsd ?? 0;
  }
  const pick = (x?: { costUsd: number; total: number; calls: number }) =>
    x ? { costUsd: x.costUsd, tokens: x.total, calls: x.calls } : undefined;
  const today = pick(data.usage?.today);
  const week = pick(data.usage?.week);
  const notes: string[] = [];
  if (s.missing) notes.push(t('有 {0} 轮没有返回用量数据，未计入。', s.missing));
  if (!s.costUsd && s.turns > s.missing)
    notes.push(t('这一端没有返回费用；今日 / 近 7 天按本机价格表估算。'));
  return {
    kind: 'cost',
    title: t('用量与费用'),
    session: s,
    ...(today ? { today } : {}),
    ...(week ? { week } : {}),
    notes,
  };
}

// ───────────────────────────── /status ─────────────────────────────

export function statusCard(ctx: SlashContext, data: SlashData): SlashCardInput {
  const m = currentModel(ctx, data);
  const rows: CardRow[] = [];
  rows.push({ label: t('端'), value: ENDPOINT_FULL[ctx.backend]() });
  rows.push(
    m.model
      ? { label: t('模型'), value: m.model }
      : {
          label: t('模型'),
          value: ctx.backend === 'nomi' ? t('未配置') : t('由 CLI 自己决定'),
          tone: 'muted',
        },
  );
  rows.push({
    label: t('供应商'),
    value: m.provider
      ? m.profile
        ? t('{0}（第三方供应商）', m.provider)
        : m.provider
      : ctx.backend === 'nomi'
        ? t('未配置')
        : t('CLI 自带登录 / 默认配置'),
    ...(m.provider ? {} : { tone: 'muted' as const }),
  });
  const auth = data.quota?.auth;
  rows.push({
    label: t('登录方式'),
    value:
      ctx.backend === 'nomi' || m.profile
        ? t('API 密钥')
        : auth === 'subscription'
          ? t('账号登录（订阅）')
          : auth === 'api'
            ? t('API 密钥')
            : t('未确认'),
    ...(ctx.backend !== 'nomi' && !m.profile && !auth ? { tone: 'muted' as const } : {}),
  });
  if (data.quota?.plan) rows.push({ label: t('套餐'), value: data.quota.plan });
  if (ctx.backend !== 'nomi')
    rows.push({
      label: t('CLI 版本'),
      value: data.cli?.version ?? t('未检测到'),
      ...(data.cli?.version ? {} : { tone: 'warn' as const }),
    });
  if (ctx.cwd) rows.push({ label: t('工作目录'), value: ctx.cwd });
  if (ctx.session)
    rows.push({
      label: t('会话'),
      value: ctx.session.id ? ctx.session.id.slice(0, 8) : t('尚未开始'),
    });
  rows.push({
    label: t('状态'),
    value: ctx.session?.running ? t('正在运行') : t('空闲'),
  });
  rows.push({ label: t('消息数'), value: String(ctx.messages.length) });
  return { kind: 'status', title: t('当前状态'), rows };
}

// ───────────────────────────── /model ─────────────────────────────

interface ModelChoice {
  label: string;
  provider: string;
  model: string;
  active: boolean;
  run: () => Promise<void>;
}

function nomiChoices(ctx: SlashContext, data: SlashData): ModelChoice[] {
  const out: ModelChoice[] = nomiModelChoices(data.nomiGateway).map((c) => ({
    label: c.label,
    provider: c.provider,
    model: c.model,
    active: c.current,
    run: () => ctx.actions.switchNomiModel(c.ref),
  }));
  // 环境变量提供的供应商还不在网关里（过渡期）：网关没有分配时由旧存储路由
  const np = data.nomiProviders;
  const gatewayMain = data.nomiGateway?.clients.nomi?.models.main;
  for (const e of np?.envProviders ?? [])
    if (e.defaultModel && (e.hasKey || e.keyless))
      out.push({
        label: `${e.name} · ${e.defaultModel}`,
        provider: e.name,
        model: e.defaultModel,
        active: !gatewayMain && np?.effectiveProviderId === e.id,
        run: () => ctx.actions.useNomiEnvProvider(e.id, e.defaultModel!),
      });
  return out;
}

function cliChoices(ctx: SlashContext, data: SlashData): ModelChoice[] {
  const profiles = (data.cliProviders?.profiles ?? []).filter((p) => p.kind === ctx.backend);
  const fail = (e?: string) => {
    throw new Error(e || t('切换失败'));
  };
  const out: ModelChoice[] = [
    {
      label: t('CLI 自带登录 / 默认配置'),
      provider: t('默认'),
      model: '',
      active: !profiles.some((p) => p.active),
      run: async () => {
        const r = await ctx.actions.deactivateCliProfile();
        if (!r.ok) fail(r.error);
      },
    },
  ];
  for (const p of profiles)
    out.push({
      label: `${p.name} · ${p.model}`,
      provider: p.name,
      model: p.model,
      active: p.active,
      run: async () => {
        const r = await ctx.actions.activateCliProfile(p.id);
        if (!r.ok) fail(r.error);
      },
    });
  return out;
}

/** 与输入框模型按钮、主进程同一套模型 id 字符集（自定义模型 id 用） */
const MODEL_ID = /^[A-Za-z0-9_][A-Za-z0-9._:/[\]-]{0,127}$/;

/**
 * CLI 标签的 `/model`：与输入框的模型按钮一致——列这个标签的模型目录（官方账号读 CLI 自己，
 * 第三方供应商读它的 /models），切换只作用于当前标签、下一条消息起生效；参数可以是自定义模型 id。
 */
async function tabModelCard(
  ctx: SlashContext,
  catalog: BackendModelCatalog,
  current: string | null,
  args: string,
): Promise<SlashCardInput> {
  const source = catalog.provider?.name || ENDPOINT_FULL[ctx.backend]();
  const defaultLabel = catalog.defaultModel?.label ?? catalog.defaultModel?.id;
  const pick = (model: string) => ctx.actions.setTabModel(model);
  const choices: ModelChoice[] = [
    {
      label: defaultLabel ? t('默认模型 · {0}', defaultLabel) : t('默认模型'),
      provider: source,
      model: '',
      active: !current,
      run: () => pick(''),
    },
    ...catalog.models.map((m) => ({
      label: m.label ?? m.id,
      provider: source,
      model: m.id,
      active: current === m.id,
      run: () => pick(m.id),
    })),
  ];
  if (current && !catalog.models.some((m) => m.id === current))
    choices.push({
      label: t('{0}（自定义）', current),
      provider: source,
      model: current,
      active: true,
      run: () => pick(current),
    });
  const done = (label: string) =>
    notice(t('模型已切换'), t('已切换到 {0}', label), 'info', {
      detail: t('只影响当前标签，下一条消息起生效。'),
    });
  const q = args.trim();
  let list = choices;
  if (q) {
    const ranked = rankItems(choices, q, (c) => [
      { text: c.model, weight: 3 },
      { text: c.label, weight: 1 },
    ]);
    const exact = ranked.filter((r) => r.item.model.toLowerCase() === q.toLowerCase());
    const hit = exact.length === 1 ? exact : ranked.length === 1 ? ranked : null;
    try {
      if (hit) {
        const c = hit[0]!.item;
        if (c.active) return notice(t('模型'), t('已经在使用 {0}', c.label));
        await c.run();
        return done(c.label);
      }
      // 目录里没有：和模型按钮的「自定义模型 id」一样直接用
      if (!ranked.length && MODEL_ID.test(q)) {
        await pick(q);
        return done(t('{0}（自定义）', q));
      }
    } catch (e) {
      return notice(t('切换失败'), e instanceof Error ? e.message : String(e), 'error');
    }
    list = ranked.map((r) => r.item);
  }
  return {
    kind: 'list',
    title: q ? t('匹配「{0}」的模型', q) : t('可用的模型'),
    items: list.map((c) => ({
      label: c.label,
      active: c.active,
      action: {
        id: `model:${c.model || 'default'}`,
        label: c.active ? t('当前') : t('切换'),
        run: async () => {
          await c.run();
        },
      },
    })),
    empty: t('没有匹配的模型。也可以输入完整的模型 id：/model <模型 id>'),
    actions: [
      { id: 'switch-provider', label: t('切换供应商'), run: () => ctx.actions.openSettings() },
    ],
    note: [
      catalog.provider ? t('列的是「{0}」的模型。', catalog.provider.name) : '',
      catalog.error ? t('没能从 {0} 读到模型列表：{1}', source, catalog.error) : '',
      t('只影响当前标签，下一条消息起生效；与输入框的模型按钮是同一个设置。'),
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** `/model` 的结果：无参数 = 列表；有参数且唯一命中 = 直接切换 */
export async function modelCard(
  ctx: SlashContext,
  data: SlashData,
  args: string,
): Promise<SlashCardInput> {
  if (ctx.backend !== 'nomi') {
    const tm = await ctx.actions.tabModels();
    if (tm.catalog) return tabModelCard(ctx, tm.catalog, tm.current, args);
  }
  // Nomi 对话；以及不能按标签切模型的 CLI（Gemini / 未启用第三方的 dsh）：列供应商
  const choices = ctx.backend === 'nomi' ? nomiChoices(ctx, data) : cliChoices(ctx, data);
  const note =
    ctx.backend === 'nomi'
      ? t('这里列出设置 →「模型」里启用的模型。')
      : t(
          '切换会改写这个 CLI 的配置（自动备份），下一轮对话生效；用 CLI 自带账号登录时由 CLI 自己选模型。',
        );
  const toItem = (c: ModelChoice): CardListItem => ({
    label: c.label,
    active: c.active,
    action: {
      id: `model:${c.label}`,
      label: c.active ? t('当前') : t('切换'),
      run: async () => {
        await c.run();
      },
    },
  });
  const q = args.trim();
  let list = choices;
  if (q) {
    const ranked = rankItems(choices, q, (c) => [
      { text: c.model, weight: 3 },
      { text: c.provider, weight: 2 },
      { text: c.label, weight: 1 },
    ]);
    const exact = ranked.filter((r) => r.item.model.toLowerCase() === q.toLowerCase());
    const hit = exact.length === 1 ? exact : ranked.length === 1 ? ranked : null;
    if (hit) {
      const c = hit[0]!.item;
      if (c.active) return notice(t('模型'), t('已经在使用 {0}', c.label));
      try {
        await c.run();
        return notice(
          t('模型已切换'),
          t('已切换到 {0}', c.label),
          'info',
          ctx.backend === 'nomi' ? undefined : { detail: t('下一轮对话生效。') },
        );
      } catch (e) {
        return notice(t('切换失败'), e instanceof Error ? e.message : String(e), 'error');
      }
    }
    list = ranked.map((r) => r.item);
  }
  return {
    kind: 'list',
    title: q ? t('匹配「{0}」的模型', q) : t('可用的模型'),
    items: list.map(toItem),
    empty: choices.length
      ? t('没有匹配的模型。')
      : ctx.backend === 'nomi'
        ? t('还没有可切换的模型，请先在设置 →「模型」里添加第三方供应商。')
        : t('还没有可切换的模型，请先在「供应商与模型」里添加。'),
    actions: [
      {
        id: 'open-providers',
        label: t('打开供应商设置'),
        run: () =>
          ctx.backend === 'nomi' ? ctx.actions.openProviders() : ctx.actions.openSettings(),
      },
    ],
    note,
  };
}

// ───────────────────────────── /help ─────────────────────────────

const KIND_LABEL: Record<SlashKind, () => string> = {
  native: () => t('Nomi 内置'),
  passthrough: () => t('转给 CLI'),
  expand: () => t('展开为提示词'),
  unsupported: () => t('不支持'),
  ui: () => t('打开界面'),
};
export const kindLabel = (k: SlashKind): string => KIND_LABEL[k]();

const SOURCE_LABEL: Record<string, () => string> = {
  builtin: () => 'Nomi',
  endpoint: () => t('当前端'),
  project: () => t('项目命令'),
  user: () => t('用户命令'),
  plugin: () => t('插件'),
  skill: () => t('Skills'),
  ui: () => t('界面'),
};
export const sourceLabel = (s: string): string => SOURCE_LABEL[s]?.() ?? s;

export function helpCard(cmds: readonly SlashCommand[]): SlashCardInput {
  const items: CardListItem[] = [];
  for (const src of SLASH_SOURCE_ORDER)
    for (const c of cmds.filter((x) => x.source === src && x.kind !== 'unsupported'))
      items.push({
        group: sourceLabel(src),
        label: `/${c.name}`,
        ...(c.args ? { hint: c.args.hint } : {}),
        description: c.disabled ? c.disabled.reason : c.description,
        badge: c.disabled ? t('不可用') : kindLabel(c.kind),
      });
  return {
    kind: 'list',
    title: t('可用命令'),
    items,
    empty: t('没有可用命令。'),
    actions: [],
  };
}

// ─────────────────────── 未知 / 不支持 / 错误 ───────────────────────

export function unknownCard(
  name: string,
  cmds: readonly SlashCommand[],
  rawText: string,
  sendPlain: (text: string) => void,
): SlashCardInput {
  const near = rankItems(
    cmds.filter((c) => c.kind !== 'unsupported'),
    name,
    (c) => [{ text: c.name, weight: 3 }, ...(c.aliases ?? []).map((a) => ({ text: a, weight: 2 }))],
  ).slice(0, 4);
  return notice(t('未知命令'), t('没有叫 /{0} 的命令，已拦下，没有发给模型。', name), 'warn', {
    ...(near.length
      ? { detail: t('你可能想输入：{0}', near.map((r) => `/${r.item.name}`).join('  ')) }
      : {}),
    actions: [
      {
        id: 'send-plain',
        label: t('作为普通文字发送'),
        run: () => sendPlain(rawText),
      },
    ],
  });
}

export function unsupportedCard(
  name: string,
  reason: string,
  alternative: string | undefined,
): SlashCardInput {
  return notice(
    t('/{0} 暂不支持', name),
    reason,
    'warn',
    alternative ? { detail: alternative } : undefined,
  );
}

/** 同名冲突里落选、CLI 又没有指定它的写法：说明原因，不发送 */
export const disabledCard = (name: string, reason: string): SlashCardInput =>
  notice(t('/{0} 不能发送', name), reason, 'warn');

export const errorCard = (name: string, e: unknown): SlashCardInput =>
  notice(t('/{0} 执行失败', name), e instanceof Error ? e.message : String(e), 'error');
