/**
 * 各端共用的命令构造器与 Nomi 原生命令。
 * 每个端的 adapter 只声明「自己有哪些命令、怎么接管」，执行逻辑在这里复用。
 */
import { t } from '@nomi-ai/ui';

import type { SlashDiscoveryEntry } from '../../services/harnessClient';
import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
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
        ? t('列出并切换这个 CLI 使用的供应商档案 / 模型')
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
    );
  return out;
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
    alt: () => t('在 Nomi「设置 → 编程助手」里调整权限与审批方式。'),
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
};

// ───────────────────────── 提示词模板（X） ─────────────────────────

/** /review 与 /init：普通提示词，由 Nomi 展开后发给模型 */
export function promptTemplates(): SlashCommand[] {
  return [
    cmd({
      name: 'review',
      aliases: ['code-review'],
      label: t('代码审查'),
      description: t('让助手审查当前目录尚未提交的更改（Nomi 提示词模板）'),
      source: 'endpoint',
      kind: 'expand',
      hint: t('[关注点]'),
      run: (a) => ({
        type: 'send',
        text:
          t(
            '请审查当前工作目录里尚未提交的更改（可以用 git status / git diff 查看）：指出行为变化、潜在缺陷、遗漏的测试和可读性问题，按严重程度排序，并给出具体修改建议。不要直接改文件。',
          ) + (a ? `\n\n${t('重点关注：{0}', a)}` : ''),
      }),
    }),
    cmd({
      name: 'init',
      label: t('生成 AGENTS.md'),
      description: t('让助手阅读项目并生成 / 更新 AGENTS.md（Nomi 提示词模板）'),
      source: 'endpoint',
      kind: 'expand',
      run: () => ({
        type: 'send',
        text: t(
          '请阅读当前项目的结构、构建与测试方式和代码约定，在项目根目录创建或更新 AGENTS.md：包含常用命令、目录说明、代码风格和需要注意的坑。保持简短、只写你确认过的内容。',
        ),
      }),
    }),
  ];
}

// ───────────────────────── 发现的自定义条目 ─────────────────────────

const SCOPE_BADGE: Record<SlashDiscoveryEntry['scope'], () => string> = {
  project: () => t('项目'),
  user: () => t('用户'),
  plugin: () => t('插件'),
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
      e.kind === 'skill' ? 'skill' : e.scope === 'plugin' ? 'plugin' : e.scope;
    out.push(
      cmd({
        name: e.name,
        label: `/${e.name}`,
        description: e.description || e.where,
        source,
        kind: mode,
        scope: e.scope,
        badge: e.scope === 'plugin' && e.plugin ? e.plugin : SCOPE_BADGE[e.scope](),
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
