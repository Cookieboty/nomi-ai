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
      label: t('帮助'),
      description: t('列出当前端可用的所有命令，以及每个命令怎么执行'),
      source: 'builtin',
      kind: 'native',
      run: (_a, ctx) => card(helpCard(ctx.commands())),
    }),
    cmd({
      name: 'context',
      label: t('上下文用量'),
      description: t('查看这个会话占了多少上下文窗口（进度条 + 分类估算）'),
      source: 'builtin',
      kind: 'native',
      run: async (_a, ctx) => card(contextCard(ctx, await ctx.load())),
    }),
    cmd({
      name: 'cost',
      aliases: ['usage', 'stats'],
      label: t('用量与费用'),
      description: t('这个会话以及今日 / 近 7 天的 token 与费用'),
      source: 'builtin',
      kind: 'native',
      run: async (_a, ctx) => card(costCard(ctx, await ctx.load())),
    }),
    cmd({
      name: 'status',
      label: t('当前状态'),
      description: t('模型、供应商、工作目录、登录方式、CLI 版本'),
      source: 'builtin',
      kind: 'native',
      run: async (_a, ctx) => card(statusCard(ctx, await ctx.load())),
    }),
    cmd({
      name: 'model',
      label: t('切换模型'),
      description: cli
        ? t('列出并切换这个 CLI 使用的第三方供应商 / 模型')
        : t('列出并切换 Nomi 对话使用的供应商 / 模型'),
      source: 'builtin',
      kind: 'native',
      hint: t('[模型名]'),
      run: async (a, ctx) => card(await modelCard(ctx, await ctx.load(), a)),
    }),
    cmd({
      name: 'clear',
      aliases: ['new', 'reset'],
      label: t('新会话'),
      description: cli
        ? t('在同一目录开一个新标签（旧会话保留在历史里）')
        : t('开始一个新对话（旧对话保留在历史里）'),
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
      label: t('插件 / 命令'),
      description: t('打开只读面板：当前端发现的命令、Skills、插件、MCP、子代理'),
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
        label: t('未提交的更改'),
        description: t('只读显示当前目录的 git 状态与 diff'),
        source: 'builtin',
        kind: 'native',
        run: async (_a, ctx) => {
          const d = await ctx.actions.gitDiff();
          return card({ kind: 'diff', title: t('未提交的更改'), ...d });
        },
      }),
      cmd({
        name: 'mode',
        label: t('权限模式'),
        description: t('切换权限模式：plan 计划 / manual 逐项确认 / edits 自动改文件 / auto 自动'),
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
    .map((m) => `${modeLabel(m)}：${modeHint(m)}`)
    .join('\n');
  if (!arg)
    return card(
      notice(
        t('权限模式'),
        t('用法：/mode plan | manual | edits | auto；也可以在输入框里按 Shift+Tab 切换。'),
        'info',
        {
          detail: list,
        },
      ),
    );
  if (arg === 'bypass' || arg === 'yolo')
    return card(
      notice(
        t('权限模式'),
        t('「完全放开」需要在输入栏的权限模式按钮里选择并确认，不能用命令切换。'),
        'warn',
      ),
    );
  const want = MODE_ARGS[arg];
  if (!want)
    return card(notice(t('权限模式'), t('不认识「{0}」。', raw.trim()), 'warn', { detail: list }));
  const st = await harnessClient.tabs();
  const r = await harnessClient.setTabPermissionMode(st.activeTabId, want);
  const got = r.permissionMode ?? fallbackMode(backend, want);
  return card(
    notice(
      t('权限模式'),
      r.degraded
        ? t(
            '{0} 不支持「{1}」，已使用「{2}」。',
            ENDPOINT_FULL[backend](),
            modeLabel(want),
            modeLabel(got),
          )
        : t('已切换到「{0}」：{1}', modeLabel(got), modeHint(got)),
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

const TUI = () => t('这是交互式终端里的命令，Nomi 以非交互方式接入，没有对应的界面。');

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
      description: t('暂不支持（{0}）', who),
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
    alt: () => t('直接编辑项目里的 {0} 即可。', file),
  }),
  permissions: (): Unsupported => ({
    name: 'permissions',
    aliases: ['approvals', 'allowed-tools'],
    alt: () => t('用 /mode 切换权限模式，或点输入栏的权限模式按钮（Shift+Tab 循环切换）。'),
  }),
  login: (cmdline: string): Unsupported => ({
    name: 'login',
    aliases: ['logout'],
    alt: () => t('请在终端里运行 {0}。Nomi 不读取也不代你输入任何账号凭据。', cmdline),
  }),
  theme: (): Unsupported => ({ name: 'theme', aliases: ['vim', 'terminal-setup', 'statusline'] }),
  ide: (): Unsupported => ({ name: 'ide', aliases: ['doctor', 'bug', 'feedback'] }),
  mention: (): Unsupported => ({
    name: 'mention',
    alt: () => t('在输入框里直接写文件路径即可。'),
  }),
  resume: (): Unsupported => ({
    name: 'resume',
    aliases: ['fork', 'rewind', 'checkpoint'],
    alt: () => t('在左侧历史里点开旧会话即可继续。'),
  }),
  compact: (why: () => string): Unsupported => ({ name: 'compact', reason: why }),
  /** CLI 自己的审查 / 初始化。非交互模式没有对应命令时，不拿 Nomi 提示词冒充。 */
  review: (): Unsupported => ({
    name: 'review',
    aliases: ['code-review'],
    reason: () =>
      t('代码审查是这个 CLI 自己的命令。非交互接入用不了，Nomi 不会另做一套提示词来冒充。'),
    alt: () => t('请在该 CLI 的交互界面里使用 /review，或直接用文字说明要审查什么。'),
  }),
  init: (file: string): Unsupported => ({
    name: 'init',
    reason: () =>
      t('生成项目说明是这个 CLI 自己的命令。非交互接入用不了，Nomi 不会另做一套提示词来冒充。'),
    alt: () => t('请在该 CLI 的交互界面里使用 /init，或直接编辑项目里的 {0}。', file),
  }),
};

// ───────────────────────── 发现的自定义条目 ─────────────────────────

const SCOPE_BADGE: Record<SlashDiscoveryEntry['scope'], () => string> = {
  project: () => t('项目'),
  user: () => t('用户'),
  plugin: () => t('插件'),
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
                      t('/{0} 无法展开', e.name),
                      t('没有找到这个命令的文件，可能已被删除或改名。'),
                      'warn',
                    ),
                  );
                return {
                  type: 'send',
                  text: r.text,
                  ...(r.shellInjection
                    ? {
                        note: t(
                          '这个命令里有 !`…` 动态命令。Nomi 不会运行嵌入的 shell 命令，已原样保留。',
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
