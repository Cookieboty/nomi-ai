/**
 * ExtensionsPanel —— 扩展：MCP 服务器（添加 / 预设 / 导入 JSON / 连接 / 工具与信任级别）
 * 和 SKILL.md 技能包（启用、编辑、新建、从文件夹导入），以及「从其他工具导入」（Claude Code / Codex，#58）。
 */
import { ErrorState, LoadingState, t as tr, Icon } from '@nomi-ai/ui';
import {
  Badge,
  Button,
  IconButton,
  EmptyState,
  Input,
  Modal,
  Notice,
  Select,
  Switch,
  Tabs,
  Textarea,
} from '@nomi-ai/ui';
import {
  Blocks,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
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
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';
import { MigrateDialog } from './MigrateDialog';

type Tab = 'mcp' | 'skills';
// 渲染时再翻译（模块加载时调用 t() 会固定在当时的语言）
const trustOptions = () =>
  (Object.keys(TRUST_LABEL) as Trust[]).map((v) => ({
    value: v,
    label: tr(TRUST_LABEL[v]),
  }));
const TRANSPORTS = [
  { value: 'stdio', label: 'ui.foundation.local-command-stdio' },
  { value: 'http', label: 'ui.foundation.remote-http' },
  { value: 'sse', label: 'ui.foundation.remote-sse' },
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
      title={tr('ui.foundation.extensions-mcp-skills')}
      size="lg"
      bodyClassName={styles.pinnedBody}
      data-testid="ext-panel"
    >
      <div className={styles.pinned}>
        <Tabs<Tab>
          items={[
            {
              value: 'mcp',
              label: tr('ui.foundation.mcp-servers', servers.length ? ` · ${servers.length}` : ''),
            },
            {
              value: 'skills',
              label: tr('ui.foundation.skills', skills?.length ? ` · ${skills.length}` : ''),
            },
          ]}
          value={tab}
          onChange={setTab}
          aria-label={tr('ui.foundation.extensions')}
        />
        <div className={`${styles.stack} ${styles.scroll}`}>
          {err && <ErrorState detail={err} onRetry={() => void load()} data-testid="panel-error" />}
          {!list && !err && <LoadingState rows={3} />}

          {list && tab === 'mcp' && (
            <div className={styles.stack}>
              <div className={styles.toolbar}>
                <span className={`${styles.hint} ${styles.toolbarText}`}>
                  {connectedTools
                    ? tr('ui.foundation.extension-tools-available-to-the-model', connectedTools)
                    : tr('ui.foundation.mcp-servers-give-the-assistant-new-tools-files')}
                </span>
                <span className={styles.toolbarActions}>
                  <Button size="sm" onClick={() => setMigrating(true)} data-testid="migrate-open">
                    {tr('ui.foundation.import-from-other-tools')}
                  </Button>
                  <Button size="sm" onClick={() => setImporting('')} data-testid="mcp-import-open">
                    {tr('ui.foundation.import-json')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setDraft(emptyDraft())}
                    data-testid="mcp-add"
                  >
                    <Icon icon={Plus} size={14} />
                    {tr('ui.foundation.add-server')}
                  </Button>
                </span>
              </div>
              {!list.ready && (
                <Notice tone="warning">
                  {tr('ui.foundation.the-ai-service-is-still-starting-connecting-will')}
                </Notice>
              )}
              {servers.length === 0 && list.env.length === 0 ? (
                <>
                  <EmptyState
                    icon={Blocks}
                    title={tr('ui.foundation.no-mcp-servers-yet')}
                    description={tr('ui.foundation.start-from-the-popular-servers-below-or-add')}
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
                            {tr('ui.foundation.license')}
                            {p.license} {tr('ui.foundation.downloaded-by-npx-on-first-connect')}
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
                            {s.tools.length} {tr('ui.foundation.tools')}
                          </Badge>
                        )}
                        <Switch
                          checked={s.enabled}
                          onChange={(v) =>
                            void run(`t:${s.id}`, () => extClient.mcpToggle(s.id, v))
                          }
                          aria-label={tr('ui.foundation.enable', s.name)}
                        />
                      </div>
                      <div className={styles.meta}>
                        {s.transport === 'stdio' ? `$ ${s.command} ${joinArgs(s.args)}` : s.url}{' '}
                        {tr('ui.foundation.calls')}
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
                                  {t.readOnly && (
                                    <Badge tone="success">{tr('ui.foundation.read-only')}</Badge>
                                  )}
                                  {t.dangerous && (
                                    <Badge tone="danger">{tr('ui.foundation.destructive')}</Badge>
                                  )}
                                  <span className={styles.hint}>{tr(t.description)}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className={styles.hint}>
                              {tr('ui.foundation.once-connected-the-server-s-tools-are-listed')}
                            </p>
                          )}
                          <div className={styles.row}>
                            {s.status === 'connected' ? (
                              <Button
                                size="sm"
                                onClick={() =>
                                  void run(`c:${s.id}`, () => extClient.mcpDisconnect(s.id))
                                }
                              >
                                {tr('ui.foundation.disconnect')}
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
                                  ? tr('ui.foundation.connecting')
                                  : s.status === 'error'
                                    ? tr('ui.foundation.retry')
                                    : tr('ui.foundation.connect')}
                              </Button>
                            )}
                            <Button size="sm" onClick={() => setDraft(fromServer(s))}>
                              {tr('ui.foundation.edit')}
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={async () => {
                                if (
                                  await confirmDialog({
                                    message: tr('ui.foundation.delete-mcp-server', s.name),
                                    danger: true,
                                  })
                                )
                                  void run(`r:${s.id}`, () => extClient.mcpRemove(s.id));
                              }}
                            >
                              {tr('ui.foundation.delete')}
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
                        <Badge tone="neutral">
                          {tr('ui.foundation.from-the-mcp-servers-environment-variable')}
                        </Badge>
                        <Badge tone="success">
                          {s.tools.length} {tr('ui.foundation.tools')}
                        </Badge>
                      </div>
                      {s.tools.some((x) => x.dangerous) && (
                        <p className={styles.hint}>
                          {tr('ui.foundation.includes-write-execute-tools-every-call-will-ask')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <p className={styles.hint}>
                {tr('ui.foundation.before-calling-an-extension-tool-you-ll-be')}
              </p>
            </div>
          )}

          {skills && tab === 'skills' && (
            <div className={styles.stack}>
              <div className={styles.toolbar}>
                <span className={`${styles.hint} ${styles.toolbarText}`}>
                  {tr('ui.foundation.a-skill-is-a-skill-md-guide-the')}
                </span>
                <span className={styles.toolbarActions}>
                  <IconButton
                    size="sm"
                    label={tr('ui.foundation.open-skills-folder')}
                    icon={<Icon icon={FolderOpen} size={14} />}
                    onClick={() => void extClient.skillOpen()}
                  />
                  <Button
                    size="sm"
                    onClick={() => setMigrating(true)}
                    data-testid="migrate-open-skills"
                  >
                    {tr('ui.foundation.import-from-other-tools')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void run('import', () => extClient.skillImport())}
                    data-testid="skill-import"
                  >
                    {tr('ui.foundation.import-from-folder')}
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
                    {tr('ui.foundation.new-skill')}
                  </Button>
                </span>
              </div>
              {skills.length === 0 ? (
                <EmptyState
                  icon={BookOpen}
                  title={tr('ui.foundation.no-skills-yet')}
                  description={tr('ui.foundation.create-one-or-import-a-folder-containing-skill')}
                />
              ) : (
                <div className={styles.list} data-testid="skill-list">
                  {skills.map((s) => (
                    <div key={s.dir} className={styles.card}>
                      <div className={styles.cardHead}>
                        <b className={styles.grow}>{tr(s.name)}</b>
                        {s.builtin && (
                          <Badge tone="accent">{tr('ui.foundation.built-in-example')}</Badge>
                        )}
                        {s.version && <Badge tone="neutral">v{s.version}</Badge>}
                        {s.files.length > 0 && (
                          <Badge tone="neutral">
                            {s.files.length} {tr('ui.foundation.attachments')}
                          </Badge>
                        )}
                        {!s.error && (
                          <IconButton
                            size="sm"
                            label={tr('ui.chat-settings.edit-skill', s.name)}
                            icon={<Icon icon={Pencil} size={14} />}
                            onClick={async () =>
                              setSkill({
                                ...(await extClient.skillGet(s.name)),
                                originalName: s.name,
                              })
                            }
                          />
                        )}
                        <IconButton
                          size="sm"
                          label={tr('ui.chat-settings.delete-skill', s.name)}
                          icon={<Icon icon={Trash2} size={14} />}
                          onClick={async () => {
                            if (
                              await confirmDialog({
                                message: tr('ui.foundation.delete-skill-and-its-folder', s.name),
                                danger: true,
                              })
                            )
                              void run(`d:${s.name}`, () => extClient.skillRemove(s.name));
                          }}
                        />
                        {!s.error && (
                          <Switch
                            checked={s.enabled}
                            onChange={(v) =>
                              void run(`s:${s.name}`, () => extClient.skillToggle(s.name, v))
                            }
                            aria-label={tr('ui.foundation.enable-skill', s.name)}
                          />
                        )}
                      </div>
                      {s.error ? (
                        <div className={styles.err}>
                          {tr('ui.foundation.couldn-t-read')}
                          {s.error}
                        </div>
                      ) : (
                        <div className={styles.meta}>{tr(s.description)}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* MCP 编辑 */}
      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? tr('ui.foundation.edit-mcp-server') : tr('ui.foundation.add-mcp-server')}
        footer={
          <div className={styles.row}>
            <Button onClick={() => setDraft(null)}>{tr('ui.foundation.cancel')}</Button>
            <Button onClick={() => void saveDraft(false)} data-testid="mcp-save">
              {tr('ui.foundation.save')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void saveDraft(true)}
              data-testid="mcp-save-connect"
            >
              {tr('ui.foundation.save-and-connect')}
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
              {tr('ui.foundation.name')}
              <Input
                size="sm"
                value={tr(draft.name)}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={tr('ui.foundation.e-g-project-files')}
                data-testid="mcp-name"
                autoFocus
              />
            </label>
            <div className={styles.row}>
              <label className={styles.field}>
                {tr('ui.foundation.transport')}
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
                {tr('ui.foundation.call-confirmation')}
                <div className={styles.selectBox}>
                  <Select
                    size="sm"
                    value={draft.trust}
                    options={trustOptions()}
                    onChange={(e) => setDraft({ ...draft, trust: e.target.value as Trust })}
                    data-testid="mcp-trust"
                  />
                </div>
              </label>
            </div>
            {draft.transport === 'stdio' ? (
              <>
                <label className={styles.field}>
                  {tr('ui.foundation.command')}
                  <Input
                    value={draft.command}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                    placeholder={tr('ui.foundation.npx-uvx-node-full-path-to-an-executable')}
                    data-testid="mcp-command"
                  />
                </label>
                <label className={styles.field}>
                  {tr('ui.foundation.arguments')}
                  <Input
                    value={draft.args}
                    onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                    placeholder='-y @modelcontextprotocol/server-filesystem "/Users/me/Documents"'
                    data-testid="mcp-args"
                  />
                </label>
                <label className={styles.field}>
                  {tr('ui.foundation.environment-variables-one-key-value-per-line')}
                  <Textarea
                    rows={2}
                    value={draft.env}
                    onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                  />
                </label>
                {draft.args.includes('{dir}') && (
                  <Notice tone="warning">
                    {tr('ui.foundation.replace-the')} {'{dir}'}{' '}
                    {tr('ui.foundation.in-the-arguments-with-the-folder-path-to')}
                  </Notice>
                )}
              </>
            ) : (
              <>
                <label className={styles.field}>
                  {tr('ui.foundation.server-url')}
                  <Input
                    value={draft.url}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    placeholder="https://example.com/mcp"
                    data-testid="mcp-url"
                  />
                </label>
                <label className={styles.field}>
                  {tr('ui.foundation.headers-one-key-value-per-line-e-g')}
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
        title={tr('ui.foundation.import-mcp-config')}
        footer={
          <div className={styles.row}>
            <Button onClick={() => setImporting(null)}>{tr('ui.foundation.cancel')}</Button>
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
              {tr('ui.foundation.import')}
            </Button>
          </div>
        }
      >
        <div className={styles.stack}>
          <p className={styles.hint}>
            {tr('ui.foundation.paste-the-common')} {'{ "mcpServers": { … } }'}{' '}
            {tr('ui.foundation.format-shared-by-many-clients-imported-servers-aren')}
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
        title={
          skill?.originalName
            ? tr('ui.foundation.edit-skill', skill.originalName)
            : tr('ui.foundation.new-skill')
        }
        footer={
          <div className={styles.row}>
            <span className={styles.hint}>{tr('ui.foundation.ctrl-s-to-save')}</span>
            <span className={styles.grow} />
            <Button onClick={() => setSkill(null)}>{tr('ui.foundation.cancel')}</Button>
            <Button variant="primary" onClick={() => void saveSkill()} data-testid="skill-save">
              {tr('ui.foundation.save')}
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
                {tr('ui.foundation.name-lowercase-letters-digits-hyphens')}
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
                {tr('ui.foundation.version')}
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
              {tr('ui.foundation.when-to-use-description')}
              <Input
                value={tr(skill.meta.description)}
                onChange={(e) =>
                  setSkill({ ...skill, meta: { ...skill.meta, description: e.target.value } })
                }
                placeholder={tr('ui.foundation.use-when-the-user-wants-to-plan-a')}
                data-testid="skill-desc"
              />
            </label>
            <label className={styles.field}>
              {tr('ui.foundation.instructions-markdown-steps-for-the-assistant')}
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
                {tr('ui.foundation.attachments-prefix')}
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
