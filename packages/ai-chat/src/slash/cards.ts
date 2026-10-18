/**
 * 原生命令的结果卡片构造（纯函数：输入数据 → 卡片内容）。
 * 卡片显示在会话流里，不发给模型。
 */
import { t } from '@nomi-ai/ui';

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
  /** 来自 Nomi 里启用的 CLI 档案 */
  profile: boolean;
}

export function currentModel(ctx: SlashContext, data: SlashData): ModelInfo {
  if (ctx.backend === 'nomi') {
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
  if (active) return { model: active.model, provider: active.name, profile: true };
  const used = data.usage?.byModel?.[0]?.key;
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
        ? t('{0}（Nomi 档案）', m.provider)
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

const MAX_MODELS_PER_PROVIDER = 12;

function nomiChoices(ctx: SlashContext, data: SlashData): ModelChoice[] {
  const np = data.nomiProviders;
  if (!np) return [];
  const out: ModelChoice[] = [];
  const act = np.effectiveProviderId;
  for (const p of np.providers) {
    if (!p.enabled) continue;
    const models = Array.from(new Set([p.defaultModel, ...p.models].filter(Boolean))).slice(
      0,
      MAX_MODELS_PER_PROVIDER,
    );
    for (const model of models)
      out.push({
        label: `${p.name} · ${model}`,
        provider: p.name,
        model,
        active: p.id === act && model === np.effectiveModel,
        run: () => ctx.actions.switchNomiModel(p.id, model),
      });
  }
  for (const p of np.envProviders)
    if (p.defaultModel)
      out.push({
        label: `${p.name} · ${p.defaultModel}`,
        provider: p.name,
        model: p.defaultModel,
        active: p.id === act && p.defaultModel === np.effectiveModel,
        run: () => ctx.actions.switchNomiModel(p.id, p.defaultModel),
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

/** `/model` 的结果：无参数 = 列表；有参数且唯一命中 = 直接切换 */
export async function modelCard(
  ctx: SlashContext,
  data: SlashData,
  args: string,
): Promise<SlashCardInput> {
  const choices = ctx.backend === 'nomi' ? nomiChoices(ctx, data) : cliChoices(ctx, data);
  const note =
    ctx.backend === 'nomi'
      ? t('这里只列出在「供应商与模型」里启用的供应商。')
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
  builtin: () => t('内置'),
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
    for (const c of cmds.filter((x) => x.source === src))
      items.push({
        group: sourceLabel(src),
        label: `/${c.name}`,
        ...(c.args ? { hint: c.args.hint } : {}),
        description: c.description,
        badge: kindLabel(c.kind),
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
  const near = rankItems(cmds, name, (c) => [
    { text: c.name, weight: 3 },
    ...(c.aliases ?? []).map((a) => ({ text: a, weight: 2 })),
  ]).slice(0, 4);
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

export const errorCard = (name: string, e: unknown): SlashCardInput =>
  notice(t('/{0} 执行失败', name), e instanceof Error ? e.message : String(e), 'error');
