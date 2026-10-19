/**
 * ExtensionsPanel —— 扩展：MCP 服务器（添加 / 预设 / 导入 JSON / 连接 / 工具与信任级别）
 * 和 SKILL.md 技能包（启用、编辑、新建、从文件夹导入），以及「从其他工具导入」（Claude Code / Codex，#58）。
 */
import { ErrorState, LoadingState, t as tr, Icon } from '@nomi-ai/ui';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Modal,
  Notice,
  Select,
  SkeletonList,
  Switch,
  Tabs,
  Textarea,
} from '@nomi-ai/ui';
import { Blocks, BookOpen, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  STATUS_LABEL,
  TRUST_LABEL,
  extClient,
  joinArgs,
  kvText,
  parseKv,
  splitArgs,
  type McpList,
  type McpPreset,
  type McpServer,
  type SkillDoc,
  type SkillInfo,
  type Trust,
} from '../../services/extClient';

import styles from './index.module.css';
import { MigrateDialog } from './MigrateDialog';

type Tab = 'mcp' | 'skills';
const TRUST_OPTIONS = (Object.keys(TRUST_LABEL) as Trust[]).map((v) => ({
  value: v,
  label: tr(TRUST_LABEL[v]),
}));
const TRANSPORTS = [
  { value: 'stdio', label: '本地命令（stdio）' },
  { value: 'http', label: '远程 HTTP' },
  { value: 'sse', label: '远程 SSE' },
];
const tone = (s: McpServer['status']) =>
  s === 'connected'
    ? 'success'
    : s === 'error'
      ? 'danger'
      : s === 'connecting'
        ? 'accent'
        : 'neutral';

interface Draft {
  id?: string;
  name: string;
  transport: McpServer['transport'];
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
  trust: Trust;
}
const emptyDraft = (): Draft => ({
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: '',
  headers: '',
  trust: 'ask',
});
const fromServer = (s: McpServer): Draft => ({
  id: s.id,
  name: s.name,
  transport: s.transport,
  command: s.command ?? '',
  args: joinArgs(s.args),
  url: s.url ?? '',
  env: kvText(s.env),
  headers: kvText(s.headers),
  trust: s.trust,
});
const fromPreset = (p: McpPreset): Draft => ({
  ...emptyDraft(),
  name: p.name,
  transport: (p.server.transport as Draft['transport']) ?? 'stdio',
  command: p.server.command ?? '',
  args: joinArgs(p.server.args),
  url: p.server.url ?? '',
});

export const ExtensionsPanel: React.FC<{ isVisible: boolean; onClose: () => void }> = ({
  isVisible,
  onClose,
}) => {
  const [tab, setTab] = useState<Tab>('mcp');
  const [list, setList] = useState<McpList | null>(null);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftErr, setDraftErr] = useState('');
  const [importing, setImporting] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [skill, setSkill] = useState<(SkillDoc & { originalName?: string }) | null>(null);
  const [skillErr, setSkillErr] = useState('');
  const [migrating, setMigrating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [l, s] = await Promise.all([extClient.mcpList(), extClient.skills()]);
      setList(l);
      setSkills(s);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!isVisible) return;
    // 面板可见时初次拉取 + 订阅后端变更：属于外部数据同步，豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return extClient.onChanged(() => void load());
  }, [isVisible, load]);
  useEffect(() => {
    if (!isVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        setTab(e.key === '1' ? 'mcp' : 'skills');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !draft && !skill) {
        e.preventDefault();
        if (tab === 'mcp') setDraft(emptyDraft());
        else setSkill({ meta: { name: '', description: '' }, body: '', files: [] });
      }
    };
    // document 先于 window 收到事件：面板内的 ⌘/Ctrl+N（新建扩展）优先于全局「新对话」
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isVisible, tab, draft, skill]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      void load();
    }
  };

  const saveDraft = async (connect: boolean) => {
    if (!draft) return;
    setDraftErr('');
    try {
      const s = await extClient.mcpUpsert({
        id: draft.id,
        name: draft.name.trim(),
        transport: draft.transport,
        trust: draft.trust,
        ...(draft.transport === 'stdio'
          ? { command: draft.command.trim(), args: splitArgs(draft.args), env: parseKv(draft.env) }
          : { url: draft.url.trim(), headers: parseKv(draft.headers) }),
        enabled: connect ? true : undefined,
      });
      setDraft(null);
      setOpen(s.id);
      if (connect) await run(`c:${s.id}`, () => extClient.mcpConnect(s.id));
      else void load();
    } catch (e) {
      setDraftErr((e as Error).message);
    }
  };

  const saveSkill = async () => {
    if (!skill) return;
    setSkillErr('');
    try {
      await extClient.skillSave({
        meta: skill.meta,
        body: skill.body,
        originalName: skill.originalName,
      });
      setSkill(null);
      void load();
    } catch (e) {
      setSkillErr((e as Error).message);
    }
  };

  const servers = list?.servers ?? [];
  const connectedTools = servers.reduce(
    (n, s) => n + (s.status === 'connected' ? s.tools.length : 0),
    0,
  );

  return (
    <Modal
      open={isVisible}
      // 子弹窗打开时 Esc 只关子弹窗
      onClose={() => {
        if (draft || skill || importing !== null || migrating) return;
        onClose();
      }}
      title={tr('扩展：MCP 与技能')}
      size="lg"
      data-testid="ext-panel"
    >
      <div className={styles.stack}>
        <Tabs<Tab>
          items={[
            {
              value: 'mcp',
              label: tr('MCP 服务器{0}', servers.length ? ` · ${servers.length}` : ''),
            },
            { value: 'skills', label: tr('技能{0}', skills?.length ? ` · ${skills.length}` : '') },
          ]}
          value={tab}
          onChange={setTab}
          aria-label={tr('扩展')}
        />
        {err && <ErrorState detail={err} onRetry={() => void load()} data-testid="panel-error" />}
        {!list && !err && <LoadingState rows={3} />}

        {list && tab === 'mcp' && (
          <div className={styles.stack}>
            <div className={styles.row}>
              <span className={styles.hint}>
                {connectedTools
                  ? tr('已向模型提供 {0} 个扩展工具', connectedTools)
                  : tr('MCP 服务器可以给助手接入新工具（文件、网页、数据库…）')}
              </span>
              <span className={styles.grow} />
              <Button size="sm" onClick={() => setMigrating(true)} data-testid="migrate-open">
                {tr('从其他工具导入')}
              </Button>
              <Button size="sm" onClick={() => setImporting('')} data-testid="mcp-import-open">
                {tr('导入 JSON')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setDraft(emptyDraft())}
                data-testid="mcp-add"
              >
                <Icon icon={Plus} size={14} />
                {tr('添加服务器')}
              </Button>
            </div>
            {!list.ready && (
              <Notice tone="warning">{tr('AI 服务还在启动，连接功能稍后可用。')}</Notice>
            )}
            {servers.length === 0 && list.env.length === 0 ? (
              <>
                <EmptyState
                  icon={Blocks}
                  title={tr('还没有 MCP 服务器')}
                  description={tr('从下面的常用服务器开始，或添加自己的。')}
                />
                <div className={styles.presets}>
                  {list.presets.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      className={styles.preset}
                      onClick={() => setDraft(fromPreset(p))}
                      data-testid={`mcp-preset-${p.key}`}
                    >
                      <b>{tr(p.name)}</b>
                      <span className={styles.hint}>{tr(p.description)}</span>
                      {p.license !== '—' && (
                        <span className={styles.hint}>
                          {tr('许可：')}
                          {p.license} {tr('· 首次连接由 npx 下载')}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className={styles.list} data-testid="mcp-list">
                {servers.map((s) => (
                  <div key={s.id} className={styles.card} data-testid={`mcp-server-${s.id}`}>
                    <div className={styles.cardHead}>
                      <button
                        type="button"
                        className={styles.expand}
                        onClick={() => setOpen(open === s.id ? null : s.id)}
                        aria-expanded={open === s.id}
                      >
                        <Icon icon={open === s.id ? ChevronDown : ChevronRight} />
                      </button>
                      <b className={styles.grow}>{tr(s.name)}</b>
                      <Badge tone={tone(s.status)} data-testid="mcp-status">
                        {tr(STATUS_LABEL[s.status])}
                      </Badge>
                      {s.status === 'connected' && (
                        <Badge tone="neutral">
                          {s.tools.length} {tr('个工具')}
                        </Badge>
                      )}
                      <Switch
                        checked={s.enabled}
                        onChange={(v) => void run(`t:${s.id}`, () => extClient.mcpToggle(s.id, v))}
                        aria-label={tr('启用 {0}', s.name)}
                      />
                    </div>
                    <div className={styles.meta}>
                      {s.transport === 'stdio' ? `$ ${s.command} ${joinArgs(s.args)}` : s.url}{' '}
                      {tr('· 调用：')}
                      {tr(TRUST_LABEL[s.trust])}
                    </div>
                    {s.error && <div className={styles.err}>{s.error}</div>}
                    {open === s.id && (
                      <div className={styles.stack}>
                        {s.tools.length > 0 ? (
                          <ul className={styles.tools}>
                            {s.tools.map((t) => (
                              <li key={t.name}>
                                <code>{t.name.replace(`${s.id}__`, '')}</code>
                                {t.readOnly && <Badge tone="success">{tr('只读')}</Badge>}
                                {t.dangerous && <Badge tone="danger">{tr('破坏性')}</Badge>}
                                <span className={styles.hint}>{tr(t.description)}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className={styles.hint}>{tr('连接后会列出这个服务器提供的工具。')}</p>
                        )}
                        <div className={styles.row}>
                          {s.status === 'connected' ? (
                            <Button
                              size="sm"
                              onClick={() =>
                                void run(`c:${s.id}`, () => extClient.mcpDisconnect(s.id))
                              }
                            >
                              {tr('断开')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={busy === `c:${s.id}`}
                              onClick={() =>
                                void run(`c:${s.id}`, () => extClient.mcpConnect(s.id))
                              }
                              data-testid="mcp-connect"
                            >
                              {busy === `c:${s.id}`
                                ? tr('连接中…')
                                : s.status === 'error'
                                  ? tr('重试连接')
                                  : tr('连接')}
                            </Button>
                          )}
                          <Button size="sm" onClick={() => setDraft(fromServer(s))}>
                            {tr('编辑')}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              if (window.confirm(tr('删除 MCP 服务器「{0}」？', s.name)))
                                void run(`r:${s.id}`, () => extClient.mcpRemove(s.id));
                            }}
                          >
                            {tr('删除')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {list.env.map((s) => (
                  <div key={s.id} className={styles.card}>
                    <div className={styles.cardHead}>
                      <b className={styles.grow}>{tr(s.name)}</b>
                      <Badge tone="neutral">{tr('来自环境变量 MCP_SERVERS')}</Badge>
                      <Badge tone="success">
                        {s.tools.length} {tr('个工具')}
                      </Badge>
                    </div>
                    {s.tools.some((x) => x.dangerous) && (
                      <p className={styles.hint}>
                        {tr('含写入 / 执行类工具，每次调用都会请你确认。')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className={styles.hint}>
              {tr(
                '调用扩展工具前会按信任级别请你确认，并记录在「桌面能力 → 操作记录」。令牌等敏感值加密保存在本机。',
              )}
            </p>
          </div>
        )}

        {skills && tab === 'skills' && (
          <div className={styles.stack}>
            <div className={styles.row}>
              <span className={styles.hint}>
                {tr('技能是一份 SKILL.md 说明书：助手平时只看到名称和描述，用到时才读取全文。')}
              </span>
              <span className={styles.grow} />
              <Button size="sm" onClick={() => void extClient.skillOpen()}>
                {tr('打开技能文件夹')}
              </Button>
              <Button
                size="sm"
                onClick={() => setMigrating(true)}
                data-testid="migrate-open-skills"
              >
                {tr('从其他工具导入')}
              </Button>
              <Button
                size="sm"
                onClick={() => void run('import', () => extClient.skillImport())}
                data-testid="skill-import"
              >
                {tr('从文件夹导入')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  setSkill({ meta: { name: '', description: '' }, body: '', files: [] })
                }
                data-testid="skill-new"
              >
                <Icon icon={Plus} size={14} />
                {tr('新建技能')}
              </Button>
            </div>
            {skills.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title={tr('还没有技能')}
                description={tr('新建一个，或导入包含 SKILL.md 的文件夹。')}
              />
            ) : (
              <div className={styles.list} data-testid="skill-list">
                {skills.map((s) => (
                  <div key={s.dir} className={styles.card}>
                    <div className={styles.cardHead}>
                      <b className={styles.grow}>{tr(s.name)}</b>
                      {s.builtin && <Badge tone="accent">{tr('内置示例')}</Badge>}
                      {s.version && <Badge tone="neutral">v{s.version}</Badge>}
                      {s.files.length > 0 && (
                        <Badge tone="neutral">
                          {s.files.length} {tr('个附件')}
                        </Badge>
                      )}
                      {!s.error && (
                        <Switch
                          checked={s.enabled}
                          onChange={(v) =>
                            void run(`s:${s.name}`, () => extClient.skillToggle(s.name, v))
                          }
                          aria-label={tr('启用技能 {0}', s.name)}
                        />
                      )}
                    </div>
                    {s.error ? (
                      <div className={styles.err}>
                        {tr('无法读取：')}
                        {s.error}
                      </div>
                    ) : (
                      <div className={styles.meta}>{tr(s.description)}</div>
                    )}
                    {!s.error && (
                      <div className={styles.row}>
                        <Button
                          size="sm"
                          onClick={async () =>
                            setSkill({
                              ...(await extClient.skillGet(s.name)),
                              originalName: s.name,
                            })
                          }
                        >
                          {tr('编辑')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            if (window.confirm(tr('删除技能「{0}」及其文件夹？', s.name)))
                              void run(`d:${s.name}`, () => extClient.skillRemove(s.name));
                          }}
                        >
                          {tr('删除')}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* MCP 编辑 */}
      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? tr('编辑 MCP 服务器') : tr('添加 MCP 服务器')}
        footer={
          <div className={styles.row}>
            <Button onClick={() => setDraft(null)}>{tr('取消')}</Button>
            <Button onClick={() => void saveDraft(false)} data-testid="mcp-save">
              {tr('保存')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void saveDraft(true)}
              data-testid="mcp-save-connect"
            >
              {tr('保存并连接')}
            </Button>
          </div>
        }
      >
        {draft && (
          <form
            className={styles.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void saveDraft(true);
            }}
          >
            <label className={styles.field}>
              {tr('名称')}
              <Input
                value={tr(draft.name)}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={tr('例如：项目文件')}
                data-testid="mcp-name"
                autoFocus
              />
            </label>
            <div className={styles.row}>
              <label className={styles.field}>
                {tr('连接方式')}
                <div className={styles.selectBox}>
                  <Select
                    size="sm"
                    value={draft.transport}
                    options={TRANSPORTS}
                    onChange={(e) =>
                      setDraft({ ...draft, transport: e.target.value as Draft['transport'] })
                    }
                    data-testid="mcp-transport"
                  />
                </div>
              </label>
              <label className={styles.field}>
                {tr('调用确认')}
                <div className={styles.selectBox}>
                  <Select
                    size="sm"
                    value={draft.trust}
                    options={TRUST_OPTIONS}
                    onChange={(e) => setDraft({ ...draft, trust: e.target.value as Trust })}
                    data-testid="mcp-trust"
                  />
                </div>
              </label>
            </div>
            {draft.transport === 'stdio' ? (
              <>
                <label className={styles.field}>
                  {tr('命令')}
                  <Input
                    value={draft.command}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                    placeholder={tr('npx / uvx / node / 可执行文件完整路径')}
                    data-testid="mcp-command"
                  />
                </label>
                <label className={styles.field}>
                  {tr('参数')}
                  <Input
                    value={draft.args}
                    onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                    placeholder='-y @modelcontextprotocol/server-filesystem "/Users/me/Documents"'
                    data-testid="mcp-args"
                  />
                </label>
                <label className={styles.field}>
                  {tr('环境变量（每行 KEY=VALUE）')}
                  <Textarea
                    rows={2}
                    value={draft.env}
                    onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                  />
                </label>
                {draft.args.includes('{dir}') && (
                  <Notice tone="warning">
                    {tr('请把参数里的')} {'{dir}'} {tr('换成要授权的文件夹路径。')}
                  </Notice>
                )}
              </>
            ) : (
              <>
                <label className={styles.field}>
                  {tr('服务器地址')}
                  <Input
                    value={draft.url}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    placeholder="https://example.com/mcp"
                    data-testid="mcp-url"
                  />
                </label>
                <label className={styles.field}>
                  {tr('请求头（每行 KEY=VALUE，如 Authorization=Bearer …）')}
                  <Textarea
                    rows={2}
                    value={draft.headers}
                    onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
                  />
                </label>
              </>
            )}
            {draftErr && (
              <div className={styles.err} data-testid="mcp-draft-error">
                {draftErr}
              </div>
            )}
          </form>
        )}
      </Modal>

      {/* 导入 */}
      <Modal
        open={importing !== null}
        onClose={() => setImporting(null)}
        title={tr('导入 MCP 配置')}
        footer={
          <div className={styles.row}>
            <Button onClick={() => setImporting(null)}>{tr('取消')}</Button>
            <Button
              variant="primary"
              disabled={!importing?.trim()}
              onClick={async () => {
                try {
                  const r = await extClient.mcpImport(importing ?? '');
                  setImporting(null);
                  setErr('');
                  void load();
                  if (r[0]) setOpen(r[0].id);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
              data-testid="mcp-import"
            >
              {tr('导入')}
            </Button>
          </div>
        }
      >
        <div className={styles.stack}>
          <p className={styles.hint}>
            {tr('粘贴常见的')} {'{ "mcpServers": { … } }'}{' '}
            {tr('格式（很多客户端通用）。导入后默认不连接，检查无误再开启。')}
          </p>
          <Textarea
            rows={8}
            value={importing ?? ''}
            onChange={(e) => setImporting(e.target.value)}
            className={styles.mono}
            data-testid="mcp-import-text"
          />
          {err && <div className={styles.err}>{err}</div>}
        </div>
      </Modal>

      <MigrateDialog
        open={migrating}
        onClose={() => setMigrating(false)}
        onDone={() => void load()}
      />

      {/* 技能编辑 */}
      <Modal
        open={!!skill}
        onClose={() => setSkill(null)}
        size="lg"
        title={skill?.originalName ? tr('编辑技能 · {0}', skill.originalName) : tr('新建技能')}
        footer={
          <div className={styles.row}>
            <span className={styles.hint}>{tr('Ctrl/⌘+S 保存')}</span>
            <span className={styles.grow} />
            <Button onClick={() => setSkill(null)}>{tr('取消')}</Button>
            <Button variant="primary" onClick={() => void saveSkill()} data-testid="skill-save">
              {tr('保存')}
            </Button>
          </div>
        }
      >
        {skill && (
          <div
            className={styles.stack}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                void saveSkill();
              }
            }}
          >
            <div className={styles.row}>
              <label className={styles.field}>
                {tr('名称（小写字母 / 数字 / 连字符）')}
                <Input
                  value={tr(skill.meta.name)}
                  onChange={(e) =>
                    setSkill({ ...skill, meta: { ...skill.meta, name: e.target.value } })
                  }
                  placeholder="travel-planner"
                  data-testid="skill-name"
                  autoFocus
                />
              </label>
              <label className={styles.field}>
                {tr('版本')}
                <Input
                  value={skill.meta.version ?? ''}
                  onChange={(e) =>
                    setSkill({ ...skill, meta: { ...skill.meta, version: e.target.value } })
                  }
                  placeholder="1.0"
                />
              </label>
            </div>
            <label className={styles.field}>
              {tr('什么时候用（描述）')}
              <Input
                value={tr(skill.meta.description)}
                onChange={(e) =>
                  setSkill({ ...skill, meta: { ...skill.meta, description: e.target.value } })
                }
                placeholder={tr('用户要规划旅行行程时使用：…')}
                data-testid="skill-desc"
              />
            </label>
            <label className={styles.field}>
              {tr('说明（Markdown，给助手看的操作步骤）')}
              <Textarea
                rows={12}
                value={skill.body}
                onChange={(e) => setSkill({ ...skill, body: e.target.value })}
                className={styles.mono}
                data-testid="skill-body"
              />
            </label>
            {skill.files.length > 0 && (
              <p className={styles.hint}>
                {tr('附件：')}
                {skill.files.join('、')}
              </p>
            )}
            {skillErr && (
              <div className={styles.err} data-testid="skill-error">
                {skillErr}
              </div>
            )}
          </div>
        )}
      </Modal>
    </Modal>
  );
};
