/**
 * PluginPanel —— 当前端的命令 / Skills / 插件 / MCP / 子代理（只读）。
 *
 * 数据来自主进程的只读发现（只读文件名与 frontmatter，不读凭据，不读 MCP 的 env / headers / args）。
 * 不提供启停开关：Claude / Codex / Grok 的启停只有交互式命令或需要改写用户的 CLI 配置，
 * 没有稳定、公开的非交互接口，Nomi 不替用户改这些文件。
 */
import { Badge, Button, EmptyState, Modal, Notice, Tabs, t as tr } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useState } from 'react';

import { extClient, type McpList, type SkillInfo } from '../../services/extClient';
import type { SlashDiscoveryEntry } from '../../services/harnessClient';
import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';

import styles from './index.module.css';

type Tab = 'commands' | 'skills' | 'plugins' | 'mcp' | 'agents';

interface Row {
  key: string;
  name: string;
  description: string;
  badges: string[];
  where?: string;
  hint?: string;
}

const SCOPE: Record<SlashDiscoveryEntry['scope'], () => string> = {
  project: () => tr('项目'),
  user: () => tr('用户'),
  plugin: () => tr('插件'),
  bundled: () => tr('Grok 自带'),
};

const toRow = (e: SlashDiscoveryEntry): Row => ({
  key: e.id,
  name: e.kind === 'command' || e.kind === 'skill' ? `/${e.name}` : e.name,
  description: e.description,
  badges: [
    e.scope === 'plugin' && e.plugin ? e.plugin : SCOPE[e.scope](),
    ...(e.transport ? [e.transport] : []),
    ...(e.kind !== 'mcp' && e.kind !== 'plugin' && !e.userInvocable ? [tr('仅模型调用')] : []),
  ],
  where: e.where,
  ...(e.argumentHint ? { hint: e.argumentHint } : {}),
});

interface Props {
  isVisible: boolean;
  onClose: () => void;
  backend: ConversationBackend;
  cwd: string;
  entries: readonly SlashDiscoveryEntry[] | null;
  /** 重新读取（打开面板与点「刷新」时） */
  onRefresh: () => void;
  /** 打开 Nomi 自己的「扩展：MCP 与技能」面板（Nomi 端） */
  onManageNomi?: () => void;
}

export const PluginPanel: React.FC<Props> = ({
  isVisible,
  onClose,
  backend,
  cwd,
  entries,
  onRefresh,
  onManageNomi,
}) => {
  const [tab, setTab] = useState<Tab>('commands');
  const [nomi, setNomi] = useState<{ skills: SkillInfo[]; mcp: McpList | null } | null>(null);
  const cli = backend !== 'nomi';

  useEffect(() => {
    if (!isVisible) return;
    onRefresh();
    if (backend !== 'nomi' || !extClient.available()) return;
    let alive = true;
    void Promise.all([
      extClient.skills().catch(() => [] as SkillInfo[]),
      extClient.mcpList().catch(() => null),
    ]).then(([skills, mcp]) => alive && setNomi({ skills, mcp }));
    return () => {
      alive = false;
    };
  }, [isVisible, backend, onRefresh]);

  const rows = useMemo<Record<Tab, Row[]>>(() => {
    const by = (kind: SlashDiscoveryEntry['kind']) =>
      (entries ?? []).filter((e) => e.kind === kind).map(toRow);
    if (!cli)
      return {
        commands: [],
        skills: (nomi?.skills ?? []).map((s) => ({
          key: s.name,
          name: `/${s.name}`,
          description: s.description,
          badges: [s.builtin ? tr('内置') : tr('自定义'), s.enabled ? tr('已启用') : tr('未启用')],
        })),
        plugins: [],
        mcp: (nomi?.mcp?.servers ?? []).map((m) => ({
          key: m.id,
          name: m.name,
          description: m.tools.length ? tr('{0} 个工具', m.tools.length) : '',
          badges: [m.transport, m.status],
        })),
        agents: [],
      };
    return {
      commands: by('command'),
      skills: by('skill'),
      plugins: by('plugin'),
      mcp: by('mcp'),
      agents: by('agent'),
    };
  }, [entries, cli, nomi]);

  const tabs: Array<{ value: Tab; label: string }> = (
    cli
      ? [
          { value: 'commands', label: tr('命令') },
          { value: 'skills', label: tr('Skills') },
          { value: 'plugins', label: tr('插件') },
          { value: 'mcp', label: tr('MCP') },
          { value: 'agents', label: tr('子代理') },
        ]
      : [
          { value: 'skills', label: tr('Skills') },
          { value: 'mcp', label: tr('MCP') },
        ]
  ).map((x) => ({
    ...x,
    label: rows[x.value as Tab].length ? `${x.label} · ${rows[x.value as Tab].length}` : x.label,
  })) as Array<{ value: Tab; label: string }>;
  const active: Tab = tabs.some((x) => x.value === tab) ? tab : (tabs[0]!.value as Tab);
  const list = rows[active];
  const unsupported = backend === 'dsh';

  return (
    <Modal
      open={isVisible}
      onClose={onClose}
      title={tr('插件 / 命令：{0}', ENDPOINT_FULL[backend]())}
      size="lg"
      data-testid="plugin-panel"
    >
      <div className={styles.stack}>
        <Notice tone="info">
          {cli
            ? tr(
                '只读视图：列出 {0} 在当前目录与用户目录里发现的命令、Skills、插件和 MCP（只读文件名与说明，不读取任何凭据）。启用 / 停用请在 CLI 里用它自己的命令。',
                ENDPOINT_FULL[backend](),
              )
            : tr('Nomi 自带的 Skills 和 MCP 服务器。输入 / 可直接使用 Skills。')}
        </Notice>
        {cli && cwd && <p className={styles.where}>{cwd}</p>}
        {unsupported ? (
          <EmptyState
            title={tr('dsh 没有公开的命令 / 插件目录')}
            data-testid="plugin-panel-empty"
          />
        ) : (
          <>
            <Tabs<Tab> items={tabs} value={active} onChange={setTab} aria-label={tr('类别')} />
            {list.length === 0 ? (
              <EmptyState title={tr('这一类下没有发现内容')} data-testid="plugin-panel-empty" />
            ) : (
              <ul className={styles.list} data-testid="plugin-panel-list">
                {list.map((r) => (
                  <li key={r.key} className={styles.row} data-testid="plugin-panel-row">
                    <div className={styles.head}>
                      <code className={styles.name}>{r.name}</code>
                      {r.hint && <span className={styles.hint}>{r.hint}</span>}
                      {r.badges.map((b) => (
                        <Badge key={b} tone="neutral">
                          {b}
                        </Badge>
                      ))}
                    </div>
                    {r.description && <div className={styles.desc}>{r.description}</div>}
                    {r.where && <div className={styles.path}>{r.where}</div>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className={styles.foot}>
          <Button size="sm" onClick={onRefresh} data-testid="plugin-panel-refresh">
            {tr('刷新')}
          </Button>
          {!cli && onManageNomi && (
            <Button size="sm" onClick={onManageNomi} data-testid="plugin-panel-manage">
              {tr('管理 Skills 与 MCP…')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
