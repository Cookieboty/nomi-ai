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
import { hasSlashCommands } from '../../utils/cliCaps';
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
  project: () => tr('ui.slash-commands.project'),
  user: () => tr('ui.slash-commands.user'),
  plugin: () => tr('ui.slash-commands.plugin'),
  bundled: () => tr('ui.slash-commands.bundled-with-grok'),
};

const toRow = (e: SlashDiscoveryEntry): Row => ({
  key: e.id,
  name: e.kind === 'command' || e.kind === 'skill' ? `/${e.name}` : e.name,
  description: e.description,
  badges: [
    e.scope === 'plugin' && e.plugin ? e.plugin : SCOPE[e.scope](),
    ...(e.transport ? [e.transport] : []),
    ...(e.kind !== 'mcp' && e.kind !== 'plugin' && !e.userInvocable
      ? [tr('ui.slash-commands.model-only')]
      : []),
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
          badges: [
            s.builtin ? tr('ui.chat-settings.built-in') : tr('ui.providers-schedule.custom'),
            s.enabled ? tr('ui.foundation.enabled') : tr('ui.slash-commands.disabled'),
          ],
        })),
        plugins: [],
        mcp: (nomi?.mcp?.servers ?? []).map((m) => ({
          key: m.id,
          name: m.name,
          description: m.tools.length ? tr('ui.slash-commands.tools', m.tools.length) : '',
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
          { value: 'commands', label: tr('ui.foundation.command') },
          { value: 'skills', label: tr('Skills') },
          { value: 'plugins', label: tr('ui.slash-commands.plugin') },
          { value: 'mcp', label: tr('MCP') },
          { value: 'agents', label: tr('ui.usage-tools.subagent') },
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
  // 没有斜杠发现能力的 CLI（如 dsh）没有可列的命令 / Skills / 插件；
  // 能力位只描述编程助手，Nomi 自己的 Skills / MCP 目录走上面的 Nomi 数据分支（#143）
  const unsupported = cli && !hasSlashCommands(backend);

  return (
    <Modal
      open={isVisible}
      onClose={onClose}
      title={tr('ui.slash-commands.plugins-commands-detail', ENDPOINT_FULL[backend]())}
      size="lg"
      data-testid="plugin-panel"
    >
      <div className={styles.stack}>
        <Notice tone="info">
          {cli
            ? tr(
                'ui.slash-commands.read-only-view-commands-skills-plugins-and-mcp',
                ENDPOINT_FULL[backend](),
              )
            : tr('ui.slash-commands.nomi-s-own-skills-and-mcp-servers-type')}
        </Notice>
        {cli && cwd && <p className={styles.where}>{cwd}</p>}
        {unsupported ? (
          <EmptyState
            title={tr('ui.slash-commands.dsh-has-no-public-command-plugin-directory')}
            data-testid="plugin-panel-empty"
          />
        ) : (
          <>
            <Tabs<Tab>
              items={tabs}
              value={active}
              onChange={setTab}
              aria-label={tr('ui.slash-commands.category')}
            />
            {list.length === 0 ? (
              <EmptyState
                title={tr('ui.slash-commands.nothing-found-in-this-category')}
                data-testid="plugin-panel-empty"
              />
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
            {tr('ui.knowledge-local.refresh')}
          </Button>
          {!cli && onManageNomi && (
            <Button size="sm" onClick={onManageNomi} data-testid="plugin-panel-manage">
              {tr('ui.slash-commands.manage-skills-and-mcp')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
