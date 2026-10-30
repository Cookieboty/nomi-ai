/**
 * 各端共用的命令构造器与 Nomi 原生命令。
 * 每个端的 adapter 只声明「自己有哪些命令、怎么接管」，执行逻辑在这里复用。
 */
import { t } from '@nomi-ai/ui';

import { harnessClient, type SlashDiscoveryEntry } from '../../services/harnessClient';
import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import {
  fallbackMode,
  modeHint,
  modeLabel,
  supportedModes,
  type PermissionMode,
} from '../../utils/permissionModes';
import {
  contextCard,
  costCard,
  helpCard,
  modelCard,
  notice,
  statusCard,
  unsupportedCard,
} from '../cards';
import type { SlashCommand, SlashContext, SlashKind, SlashOutcome, SlashSource } from '../types';

export interface CmdSpec {
  name: string;
  aliases?: string[];
  hiddenAliases?: string[];
  label: string;
  description: string;
  source: SlashSource;
  kind: SlashKind;
  hint?: string;
  scope?: SlashCommand['scope'];
  badge?: string;
  run: SlashCommand['run'];
}

export function cmd(s: CmdSpec): SlashCommand {
  return {
    id: `${s.source}:${s.name}`,
    name: s.name,
    ...(s.aliases ? { aliases: s.aliases } : {}),
    ...(s.hiddenAliases ? { hiddenAliases: s.hiddenAliases } : {}),
    label: s.label,
    description: s.description,
    source: s.source,
    kind: s.kind,
    ...(s.hint ? { args: { hint: s.hint } } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
    ...(s.badge ? { badge: s.badge } : {}),
    run: s.run,
  };
}

const card = (c: ReturnType<typeof notice>): SlashOutcome => ({ type: 'card', card: c });

// ───────────────────────── Nomi 原生命令 ─────────────────────────

export function nativeCommands(backend: ConversationBackend): SlashCommand[] {
  const cli = backend !== 'nomi';
  const out: SlashCommand[] = [
    cmd({
      name: 'help',
      aliases: ['?'],
      label: t('ui.slash-commands.help'),
      description: t('ui.slash-commands.list-every-command-available-here-and-how-each'),
      source: 'builtin',
      kind: 'native',
      run: (_a, ctx) => card(helpCard(ctx.commands())),
    }),
    cmd({
      name: 'context',
      label: t('ui.slash-commands.context-usage'),
      description: t('ui.slash-commands.see-how-much-of-the-context-window-this'),
      source: 'builtin',
      kind: 'native',
      run: async (_a, ctx) => card(contextCard(ctx, await ctx.load())),
    }),
    cmd({
      name: 'cost',
      aliases: ['usage', 'stats'],
      label: t('ui.usage-tools.usage-cost'),
      description: t('ui.slash-commands.tokens-and-cost-for-this-session-today-and'),
      source: 'builtin',
      kind: 'native',
      run: async (_a, ctx) => card(costCard(ctx, await ctx.load())),
    }),
    cmd({
      name: 'status',
      label: t('ui.slash-commands.current-status'),
      description: t('ui.slash-commands.model-provider-working-directory-login-mode-cli-version'),
      source: 'builtin',
      kind: 'native',
      run: async (_a, ctx) => card(statusCard(ctx, await ctx.load())),
    }),
    cmd({
      name: 'model',
      label: t('ui.slash-commands.switch-model'),
      description: cli
        ? t('ui.slash-commands.list-and-switch-this-tab-s-model-same')
        : t('ui.slash-commands.list-and-switch-the-provider-model-used-by'),
      source: 'builtin',
      kind: 'native',
      hint: t('ui.slash-commands.model'),
      run: async (a, ctx) => {
        // 不带参数：打开输入框上方的模型浮层（与模型按钮同一个界面），不往对话里插卡片
        if (!a.trim() && ctx.actions.openModelMenu('')) return { type: 'noop' };
        const c = await modelCard(ctx, await ctx.load(), a);
        // 参数命中多个：同样打开浮层，搜索框里填上参数；唯一命中已直接切换，留一条结果
        if (c.kind === 'list' && ctx.actions.openModelMenu(a.trim())) return { type: 'noop' };
        return card(c);
      },
    }),
    cmd({
      name: 'clear',
      aliases: ['new', 'reset'],
      label: t('ui.slash-commands.new-session'),
      description: cli
        ? t('ui.slash-commands.open-a-new-tab-in-the-same-directory')
        : t('ui.slash-commands.start-a-new-conversation-the-old-one-stays'),
      source: 'builtin',
      kind: 'native',
      run: async (_a, ctx) => {
        await ctx.actions.newSession();
        return { type: 'noop' };
      },
    }),
    cmd({
      name: 'plugins',
      aliases: ['skills', 'mcp', 'agents', 'plugin'],
      label: t('ui.slash-commands.plugins-commands'),
      description: t('ui.slash-commands.open-the-read-only-panel-commands-skills-plugins'),
      source: 'builtin',
      kind: 'ui',
      run: (_a, ctx) => {
        ctx.actions.openPlugins();
        return { type: 'noop' };
      },
    }),
  ];
  if (cli)
    out.push(
      cmd({
        name: 'diff',
        label: t('ui.slash-commands.uncommitted-changes'),
        description: t('ui.slash-commands.show-the-git-status-and-diff-of-the'),
        source: 'builtin',
        kind: 'native',
        run: async (_a, ctx) => {
          const d = await ctx.actions.gitDiff();
          return card({ kind: 'diff', title: t('ui.slash-commands.uncommitted-changes'), ...d });
        },
      }),
      cmd({
        name: 'mode',
        label: t('ui.chat-settings.permission-mode-label'),
        description: t('ui.chat-settings.switch-permission-mode-plan-manual-edits-auto-edit'),
        source: 'builtin',
        kind: 'native',
        hint: 'plan | manual | edits | auto',
        run: (a, ctx) => runMode(a, ctx.backend),
      }),
    );
  return out;
}

const MODE_ARGS: Record<string, PermissionMode> = {
  plan: 'plan',
  manual: 'manual',
  default: 'manual',
  edits: 'acceptEdits',
  acceptedits: 'acceptEdits',
  auto: 'auto',
};

/**
 * /mode：切换当前标签的权限模式。「完全放开」不能用命令进入（必须在输入栏的模式按钮里确认）；
 * 不带参数时列出当前端支持的档位。
 */
async function runMode(raw: string, backend: ConversationBackend): Promise<SlashOutcome> {
  const arg = raw.trim().toLowerCase();
  const list = supportedModes(backend)
    .filter((m) => m !== 'bypass')
    .map((m) => `${modeLabel(m)}：${modeHint(m, backend)}`)
    .join('\n');
  if (!arg)
    return card(
      notice(
        t('ui.chat-settings.permission-mode-label'),
        t('ui.chat-settings.usage-mode-plan-manual-edits-auto-you-can'),
        'info',
        {
          detail: list,
        },
      ),
    );
  if (arg === 'bypass' || arg === 'yolo')
    return card(
      notice(
        t('ui.chat-settings.permission-mode-label'),
        t('ui.chat-settings.full-access-has-to-be-chosen-and-confirmed'),
        'warn',
      ),
    );
  const want = MODE_ARGS[arg];
  if (!want)
    return card(
      notice(
        t('ui.chat-settings.permission-mode-label'),
        t('ui.chat-settings.unknown-mode', raw.trim()),
        'warn',
        { detail: list },
      ),
    );
  const st = await harnessClient.tabs();
  const r = await harnessClient.setTabPermissionMode(st.activeTabId, want);
  const got = r.permissionMode ?? fallbackMode(backend, want);
  return card(
    notice(
      t('ui.chat-settings.permission-mode-label'),
      r.degraded
        ? t(
            'ui.chat-settings.doesnt-support-using-period',
            ENDPOINT_FULL[backend](),
            modeLabel(want),
            modeLabel(got),
          )
        : t('ui.chat-settings.switched-to', modeLabel(got), modeHint(got, backend)),
      r.degraded ? 'warn' : 'info',
    ),
  );
}

// ───────────────────────── 不支持的命令 ─────────────────────────

interface Unsupported {
  name: string;
  aliases?: string[];
  /** 替代方案（已翻译） */
  alt?: () => string;
  reason?: () => string;
}

const TUI = () => t('ui.slash-commands.this-is-a-command-of-the-interactive-terminal');

export function unsupportedCommands(
  backend: ConversationBackend,
  list: Unsupported[],
): SlashCommand[] {
  const who = ENDPOINT_FULL[backend]();
  return list.map((u) =>
    cmd({
      name: u.name,
      ...(u.aliases ? { aliases: u.aliases } : {}),
      label: `/${u.name}`,
      description: t('ui.slash-commands.not-supported', who),
      source: 'endpoint',
      kind: 'unsupported',
      run: () => ({
        type: 'card',
        card: unsupportedCard(u.name, (u.reason ?? TUI)(), u.alt?.()),
      }),
    }),
  );
}

export const U = {
  memory: (file: string): Unsupported => ({
    name: 'memory',
    alt: () => t('ui.slash-commands.just-edit-in-your-project', file),
  }),
  permissions: (): Unsupported => ({
    name: 'permissions',
    aliases: ['approvals', 'allowed-tools'],
    alt: () => t('ui.chat-settings.use-mode-to-switch-the-permission-mode-or'),
  }),
  login: (cmdline: string): Unsupported => ({
    name: 'login',
    aliases: ['logout'],
    alt: () => t('ui.slash-commands.run-in-a-terminal-nomi-never-reads-or', cmdline),
  }),
  theme: (): Unsupported => ({ name: 'theme', aliases: ['vim', 'terminal-setup', 'statusline'] }),
  ide: (): Unsupported => ({ name: 'ide', aliases: ['doctor', 'bug', 'feedback'] }),
  mention: (): Unsupported => ({
    name: 'mention',
    alt: () => t('ui.slash-commands.just-write-the-file-path-in-the-input'),
  }),
  resume: (): Unsupported => ({
    name: 'resume',
    aliases: ['fork', 'rewind', 'checkpoint'],
    alt: () => t('ui.slash-commands.open-an-old-session-from-the-history-on'),
  }),
  compact: (why: () => string): Unsupported => ({ name: 'compact', reason: why }),
  /** CLI 自己的审查 / 初始化。非交互模式没有对应命令时，不拿 Nomi 提示词冒充。 */
  review: (): Unsupported => ({
    name: 'review',
    aliases: ['code-review'],
    reason: () => t('ui.slash-commands.code-review-is-this-cli-s-own-command'),
    alt: () => t('ui.slash-commands.use-review-in-that-cli-s-interactive-ui'),
  }),
  init: (file: string): Unsupported => ({
    name: 'init',
    reason: () => t('ui.slash-commands.generating-project-notes-is-this-cli-s-own'),
    alt: () => t('ui.slash-commands.use-init-in-that-cli-s-interactive-ui', file),
  }),
};

// ───────────────────────── 发现的自定义条目 ─────────────────────────

const SCOPE_BADGE: Record<SlashDiscoveryEntry['scope'], () => string> = {
  project: () => t('ui.slash-commands.project'),
  user: () => t('ui.slash-commands.user'),
  plugin: () => t('ui.slash-commands.plugin'),
  bundled: () => 'Grok',
};

/**
 * 把主进程发现的命令 / skill 变成 SlashCommand。
 * passthrough = 文本原样（`/name args`）交给 CLI；expand = Nomi 按 id 让主进程展开后发送。
 */
export function discoveredCommands(
  entries: readonly SlashDiscoveryEntry[] | null,
  mode: 'passthrough' | 'expand',
): SlashCommand[] {
  const out: SlashCommand[] = [];
  for (const e of entries ?? []) {
    if (e.kind !== 'command' && e.kind !== 'skill') continue;
    if (!e.userInvocable) continue;
    const source: SlashSource =
      e.kind === 'skill'
        ? 'skill'
        : e.scope === 'plugin'
          ? 'plugin'
          : e.scope === 'bundled'
            ? 'endpoint'
            : e.scope;
    out.push(
      cmd({
        name: e.name,
        label: `/${e.name}`,
        description: e.description || e.where,
        source,
        kind: mode,
        scope: e.scope,
        badge:
          e.scope === 'bundled'
            ? 'Grok'
            : e.scope === 'plugin' && e.plugin
              ? e.plugin
              : SCOPE_BADGE[e.scope](),
        ...(e.argumentHint ? { hint: e.argumentHint } : {}),
        run:
          mode === 'passthrough'
            ? (a) => ({ type: 'send', text: a ? `/${e.name} ${a}` : `/${e.name}` })
            : async (a, ctx: SlashContext) => {
                const r = await ctx.actions.expand(e.id, a);
                if (!r)
                  return card(
                    notice(
                      t('ui.slash-commands.could-not-be-expanded', e.name),
                      t('ui.slash-commands.the-command-file-was-not-found-it-may'),
                      'warn',
                    ),
                  );
                return {
                  type: 'send',
                  text: r.text,
                  ...(r.shellInjection
                    ? {
                        note: t(
                          'ui.slash-commands.this-command-contains-dynamic-commands-nomi-does-not',
                        ),
                      }
                    : {}),
                };
              },
      }),
    );
  }
  return out;
}
