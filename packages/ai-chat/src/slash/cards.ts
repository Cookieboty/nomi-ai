/**
 * 原生命令的结果卡片构造（纯函数：输入数据 → 卡片内容）。
 * 卡片显示在会话流里，不发给模型。
 */
import { t } from '@nomi-ai/ui';

import {
  codingModelChoices,
  refSlashLabel,
  tabSourceOf,
  thirdPartyRefOf,
} from '../services/cliSource';
import type { BackendModelCatalog, TabSource } from '../services/harnessClient';
import { nomiMainRef, nomiModelChoices, splitRef } from '../services/nomiModel';
import { providerDisplayName } from '../services/providerClient';
import { hasOfficialAccount } from '../utils/cliCaps';
import { ENDPOINT_FULL } from '../utils/endpointBadge';
import { rankItems } from '../utils/fuzzy';

import {
  contextWindowFor,
  estimateContext,
  fitContextWindow,
  reportedContextWindow,
} from './tokens';
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
  /** CLI 标签用的是第三方（经网关） */
  thirdParty: boolean;
}

export function currentModel(ctx: SlashContext, data: SlashData): ModelInfo {
  if (ctx.backend === 'nomi') {
    const gw = data.nomiGateway;
    const main = nomiMainRef(gw);
    const r = main ? splitRef(main) : null;
    if (r) {
      const p = gw!.providers.find((x) => x.id === r.provider);
      return {
        model: r.model,
        provider: p ? providerDisplayName(p.name) : r.provider,
        thirdParty: false,
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
      thirdParty: false,
    };
  }
  const tab = data.cliTab;
  if (tabSourceOf(tab) === 'thirdParty') {
    const ref = thirdPartyRefOf(tab, ctx.backend, data.nomiGateway);
    const r = ref ? splitRef(ref) : null;
    const p = r ? data.nomiGateway?.providers.find((x) => x.id === r.provider) : undefined;
    return {
      ...(r ? { model: r.model, provider: p ? providerDisplayName(p.name) : r.provider } : {}),
      thirdParty: true,
    };
  }
  const own = tab?.modelOverride?.trim();
  const used = own || data.usage?.byModel?.find((r) => r.key && r.key !== 'unknown')?.key;
  return { ...(used ? { model: used } : {}), thirdParty: false };
}

/** CLI 标签的来源，给 /status 的「供应商」一行：官方账号 /「供应商 / 模型」 */
function cliSourceLine(ctx: SlashContext, data: SlashData): CardRow {
  const label = t('ui.providers-schedule.provider');
  if (tabSourceOf(data.cliTab) === 'thirdParty') {
    const ref = thirdPartyRefOf(data.cliTab, ctx.backend, data.nomiGateway);
    return ref
      ? { label, value: t('ui.models.third-party', refSlashLabel(data.nomiGateway, ref)) }
      : { label, value: t('ui.models.third-party-no-model-set'), tone: 'warn' };
  }
  if (!hasOfficialAccount(ctx.backend)) return { label, value: t('ui.models.dsh-built-in-config') };
  const a = data.cliAccount;
  return a
    ? { label, value: t('ui.chat-settings.official', a.identity?.email ?? a.label) }
    : { label, value: t('ui.models.official'), tone: 'muted' };
}

// ───────────────────────────── /context ─────────────────────────────

export function contextCard(ctx: SlashContext, data: SlashData): SlashCardInput {
  const m = currentModel(ctx, data);
  const baseWin = contextWindowFor(m.model, reportedContextWindow(ctx.messages));
  const est = estimateContext(ctx.messages, {
    user: t('ui.slash-commands.your-messages'),
    assistant: t('ui.slash-commands.assistant-replies'),
    tools: t('ui.slash-commands.tool-calls-and-results'),
    thinking: t('ui.voice-mascot.think'),
    system: t('ui.slash-commands.system-prompt-tool-definitions-memory-inferred'),
  });
  const win = fitContextWindow(baseWin, est.used);
  const notes: string[] = [];
  notes.push(
    est.basis === 'actual'
      ? t('ui.slash-commands.the-total-comes-from-the-real-usage-returned')
      : t('ui.slash-commands.this-session-has-no-real-usage-record-yet'),
  );
  notes.push(
    win.widened
      ? t('ui.slash-commands.the-window-size-is-unknown-and-was-widened')
      : win.source === 'reported'
        ? t('ui.session-workspace.the-window-size-comes-from-the-model-info')
        : win.source === 'table'
          ? t('ui.slash-commands.the-window-size-comes-from-a-built-in')
          : t('ui.slash-commands.the-window-size-of-the-current-model-is'),
  );
  if (ctx.backend !== 'nomi')
    notes.push(t('ui.slash-commands.this-is-computed-by-nomi-from-the-session'));
  return {
    kind: 'context',
    title: t('ui.slash-commands.context-usage'),
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
  if (s.missing)
    notes.push(t('ui.slash-commands.turns-returned-no-usage-data-and-are-not', s.missing));
  if (!s.costUsd && s.turns > s.missing)
    notes.push(t('ui.slash-commands.this-endpoint-does-not-report-cost-today-last'));
  return {
    kind: 'cost',
    title: t('ui.usage-tools.usage-cost'),
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
  rows.push({ label: t('ui.slash-commands.endpoint'), value: ENDPOINT_FULL[ctx.backend]() });
  rows.push(
    m.model
      ? { label: t('ui.foundation.model'), value: m.model }
      : {
          label: t('ui.foundation.model'),
          value:
            ctx.backend === 'nomi'
              ? t('ui.providers-schedule.not-configured-63595e')
              : t('ui.slash-commands.chosen-by-the-cli-itself'),
          tone: 'muted',
        },
  );
  rows.push(
    ctx.backend === 'nomi'
      ? {
          label: t('ui.providers-schedule.provider'),
          value: m.provider ?? t('ui.providers-schedule.not-configured-63595e'),
          ...(m.provider ? {} : { tone: 'muted' as const }),
        }
      : cliSourceLine(ctx, data),
  );
  const auth = data.quota?.auth;
  rows.push({
    label: t('ui.slash-commands.login-mode'),
    value:
      ctx.backend === 'nomi' || m.thirdParty
        ? t('ui.foundation.api-key')
        : auth === 'subscription'
          ? t('ui.slash-commands.account-login-subscription')
          : auth === 'api'
            ? t('ui.foundation.api-key')
            : t('ui.slash-commands.unconfirmed'),
    ...(ctx.backend !== 'nomi' && !m.thirdParty && !auth ? { tone: 'muted' as const } : {}),
  });
  if (data.quota?.plan) rows.push({ label: t('ui.slash-commands.plan'), value: data.quota.plan });
  if (ctx.backend !== 'nomi')
    rows.push({
      label: t('ui.slash-commands.cli-version'),
      value: data.cli?.version ?? t('ui.slash-commands.not-detected'),
      ...(data.cli?.version ? {} : { tone: 'warn' as const }),
    });
  if (ctx.cwd) rows.push({ label: t('ui.cli-monitor.workspace-42dfc8'), value: ctx.cwd });
  if (ctx.session)
    rows.push({
      label: t('ui.slash-commands.session'),
      value: ctx.session.id ? ctx.session.id.slice(0, 8) : t('ui.slash-commands.not-started'),
    });
  rows.push({
    label: t('ui.cli-monitor.status'),
    value: ctx.session?.running ? t('ui.slash-commands.running') : t('ui.mascot-theme.idle'),
  });
  rows.push({ label: t('ui.slash-commands.messages'), value: String(ctx.messages.length) });
  return { kind: 'status', title: t('ui.slash-commands.current-status'), rows };
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
  return nomiModelChoices(data.nomiGateway).map((c) => ({
    label: c.label,
    provider: c.provider,
    model: c.model,
    active: c.current,
    run: () => ctx.actions.switchNomiModel(c.ref),
  }));
}

const cancelled = (ok: boolean) => {
  if (!ok) throw new Error(t('ui.models.switch-cancelled'));
};

/** CLI 标签的「官方」一项：改用官方账号（第三方 → 官方且已有对话时会先确认） */
function officialChoice(ctx: SlashContext, data: SlashData, source: TabSource): ModelChoice {
  const a = data.cliAccount;
  const label = !hasOfficialAccount(ctx.backend)
    ? t('ui.models.dsh-built-in-config')
    : a
      ? t('ui.chat-settings.official', a.identity?.email ?? a.label)
      : t('ui.models.official');
  return {
    label,
    provider: t('ui.models.official'),
    model: 'official',
    active: source === 'official',
    run: async () => cancelled(await ctx.actions.setTabSource('official')),
  };
}

/** CLI 标签的第三方候选：网关里能给编程助手用的模型，选中即让标签改用第三方的这个模型 */
function thirdPartyChoices(ctx: SlashContext, data: SlashData, source: TabSource): ModelChoice[] {
  const cur =
    source === 'thirdParty' ? thirdPartyRefOf(data.cliTab, ctx.backend, data.nomiGateway) : null;
  return codingModelChoices(data.nomiGateway).map((c) => ({
    label: t('ui.models.third-party-94671d', c.label),
    provider: c.provider,
    model: c.ref,
    active: c.ref === cur,
    run: async () => cancelled(await ctx.actions.setTabSource('thirdParty', c.ref)),
  }));
}

/** 与输入框模型按钮、主进程同一套模型 id 字符集（自定义模型 id 用） */
const MODEL_ID = /^[A-Za-z0-9_][A-Za-z0-9._:/[\]-]{0,127}$/;

/**
 * CLI 标签的 `/model`：与输入框的模型按钮一致——列这个标签的模型目录（官方来源读 CLI 自己，
 * 第三方来源是网关的模型），再附上另一种来源的候选（切换来源）。只作用于当前标签、下一条消息起生效；
 * 官方来源时参数可以是自定义模型 id。
 */
async function tabModelCard(
  ctx: SlashContext,
  catalog: BackendModelCatalog,
  current: string | null,
  args: string,
  tabSource: TabSource,
  /** 另一种来源的候选（官方标签列第三方模型，第三方标签列「官方」） */
  others: ModelChoice[],
): Promise<SlashCardInput> {
  const thirdParty = tabSource === 'thirdParty';
  const source =
    catalog.provider?.name ||
    (thirdParty ? t('ui.models.third-party-models') : ENDPOINT_FULL[ctx.backend]());
  const defaultLabel = catalog.defaultModel?.label ?? catalog.defaultModel?.id;
  const pick = (model: string) => ctx.actions.setTabModel(model, tabSource);
  const choices: ModelChoice[] = [
    {
      label: defaultLabel
        ? t('ui.slash-commands.default-model', defaultLabel)
        : t('ui.providers-schedule.default-model'),
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
      label: t('ui.slash-commands.custom', current),
      provider: source,
      model: current,
      active: true,
      run: () => pick(current),
    });
  choices.push(...others);
  const done = (label: string) =>
    notice(
      t('ui.slash-commands.model-switched'),
      t('ui.slash-commands.switched-to', label),
      'info',
      {
        detail: t('ui.slash-commands.only-affects-this-tab-starting-with-the-next'),
      },
    );
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
        if (c.active)
          return notice(t('ui.foundation.model'), t('ui.slash-commands.already-using', c.label));
        await c.run();
        return done(c.label);
      }
      // 目录里没有：和模型按钮的「自定义模型 id」一样直接用（第三方只能从网关的模型里选）
      if (!thirdParty && !ranked.length && MODEL_ID.test(q)) {
        await pick(q);
        return done(t('ui.slash-commands.custom', q));
      }
    } catch (e) {
      return notice(
        t('ui.slash-commands.switch-failed'),
        e instanceof Error ? e.message : String(e),
        'error',
      );
    }
    list = ranked.map((r) => r.item);
  }
  return {
    kind: 'list',
    title: q ? t('ui.slash-commands.models-matching', q) : t('ui.slash-commands.available-models'),
    items: list.map((c) => ({
      label: c.label,
      active: c.active,
      action: {
        id: `model:${c.model || 'default'}`,
        label: c.active ? t('ui.providers-schedule.current') : t('ui.slash-commands.switch'),
        run: async () => {
          await c.run();
        },
      },
    })),
    empty: thirdParty
      ? t('ui.slash-commands.no-matching-models')
      : t('ui.slash-commands.no-matching-models-you-can-also-enter-a'),
    actions: [
      {
        id: 'open-models',
        label: t('ui.models.open-model-settings'),
        run: () => ctx.actions.openProviders(),
      },
    ],
    note: [
      thirdParty ? t('ui.models.this-tab-uses-a-third-party-model-through') : '',
      catalog.error
        ? t('ui.chat-settings.couldn-t-read-the-model-list-from', source, catalog.error)
        : '',
      t('ui.slash-commands.only-affects-this-tab-starting-with-the-next-4110d7'),
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
  let choices: ModelChoice[];
  if (ctx.backend !== 'nomi') {
    const tm = await ctx.actions.tabModels();
    const official = officialChoice(ctx, data, tm.source);
    const third = thirdPartyChoices(ctx, data, tm.source);
    if (tm.catalog)
      return tabModelCard(
        ctx,
        tm.catalog,
        tm.current,
        args,
        tm.source,
        tm.source === 'thirdParty' ? [official] : third,
      );
    // 不能按标签切模型的 CLI（如 Gemini / dsh 官方）：只列来源
    choices = [official, ...third];
  } else choices = nomiChoices(ctx, data);
  const note =
    ctx.backend === 'nomi'
      ? t('ui.models.lists-the-models-enabled-under-settings-models')
      : t('ui.models.official-uses-the-cli-s-own-account-third');
  const toItem = (c: ModelChoice): CardListItem => ({
    label: c.label,
    active: c.active,
    action: {
      id: `model:${c.label}`,
      label: c.active ? t('ui.providers-schedule.current') : t('ui.slash-commands.switch'),
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
      if (c.active)
        return notice(t('ui.foundation.model'), t('ui.slash-commands.already-using', c.label));
      try {
        await c.run();
        return notice(
          t('ui.slash-commands.model-switched'),
          t('ui.slash-commands.switched-to', c.label),
          'info',
          ctx.backend === 'nomi'
            ? undefined
            : { detail: t('ui.slash-commands.only-affects-this-tab-starting-with-the-next') },
        );
      } catch (e) {
        return notice(
          t('ui.slash-commands.switch-failed'),
          e instanceof Error ? e.message : String(e),
          'error',
        );
      }
    }
    list = ranked.map((r) => r.item);
  }
  return {
    kind: 'list',
    title: q ? t('ui.slash-commands.models-matching', q) : t('ui.slash-commands.available-models'),
    items: list.map(toItem),
    empty: choices.length
      ? t('ui.slash-commands.no-matching-models')
      : t('ui.models.no-models-to-switch-to-yet-add-a'),
    actions: [
      {
        id: 'open-providers',
        label: t('ui.models.open-model-settings'),
        run: () => ctx.actions.openProviders(),
      },
    ],
    note,
  };
}

// ───────────────────────────── /help ─────────────────────────────

const KIND_LABEL: Record<SlashKind, () => string> = {
  native: () => t('ui.slash-commands.built-into-nomi'),
  passthrough: () => t('ui.slash-commands.sent-to-cli'),
  expand: () => t('ui.slash-commands.expands-to-prompt'),
  unsupported: () => t('ui.slash-commands.unsupported'),
  ui: () => t('ui.slash-commands.opens-ui'),
};
export const kindLabel = (k: SlashKind): string => KIND_LABEL[k]();

const SOURCE_LABEL: Record<string, () => string> = {
  builtin: () => 'Nomi',
  endpoint: () => t('ui.slash-commands.this-endpoint'),
  project: () => t('ui.slash-commands.project-commands'),
  user: () => t('ui.slash-commands.user-commands'),
  plugin: () => t('ui.slash-commands.plugin'),
  skill: () => t('Skills'),
  ui: () => t('ui.slash-commands.interface'),
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
        badge: c.disabled ? t('ui.slash-commands.unavailable') : kindLabel(c.kind),
      });
  return {
    kind: 'list',
    title: t('ui.slash-commands.available-commands'),
    items,
    empty: t('ui.slash-commands.no-commands-available'),
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
  return notice(
    t('ui.slash-commands.unknown-command'),
    t('ui.slash-commands.there-is-no-command-named-it-was-blocked', name),
    'warn',
    {
      ...(near.length
        ? {
            detail: t(
              'ui.slash-commands.did-you-mean',
              near.map((r) => `/${r.item.name}`).join('  '),
            ),
          }
        : {}),
      actions: [
        {
          id: 'send-plain',
          label: t('ui.slash-commands.send-as-plain-text'),
          run: () => sendPlain(rawText),
        },
      ],
    },
  );
}

export function unsupportedCard(
  name: string,
  reason: string,
  alternative: string | undefined,
): SlashCardInput {
  return notice(
    t('ui.slash-commands.is-not-supported', name),
    reason,
    'warn',
    alternative ? { detail: alternative } : undefined,
  );
}

/** 同名冲突里落选、CLI 又没有指定它的写法：说明原因，不发送 */
export const disabledCard = (name: string, reason: string): SlashCardInput =>
  notice(t('ui.slash-commands.can-t-be-sent', name), reason, 'warn');

export const errorCard = (name: string, e: unknown): SlashCardInput =>
  notice(t('ui.slash-commands.failed', name), e instanceof Error ? e.message : String(e), 'error');
