/**
 * DesktopPanel —— 桌面能力设置：授权文件夹（系统选择框）、工具权限、隐私（仅本地模型 / 云端提示）、
 * 操作记录（审计日志）与撤销。全部数据只保存在本机 userData。
 */
import { t as tr, Icon } from '@nomi-ai/ui';
import {
  Badge,
  Button,
  EmptyState,
  Modal,
  Notice,
  Select,
  SettingRow,
  SettingsGroup,
  Switch,
  Tabs,
} from '@nomi-ai/ui';
import { FolderLock, ScrollText, Lock, Plus, Undo2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  DANGER_LABELS,
  POLICY_LABELS,
  TOOL_LABELS,
  desktopClient,
  type AuditEntryView,
  type DesktopState,
  type JournalView,
  type Policy,
} from '../../services/desktopClient';

import styles from './index.module.css';

interface Props {
  isVisible: boolean;
  onClose: () => void;
}

type Tab = 'folders' | 'tools' | 'cloud' | 'log';

const DECISION_LABEL: Record<string, string> = {
  auto: 'ui.foundation.auto',
  allowed: 'ui.foundation.allowed',
  denied: 'ui.foundation.denied',
  timeout: 'ui.foundation.denied-timed-out',
  user: 'ui.foundation.user-action',
  error: 'ui.foundation.failed',
};

const fmt = (ts: number) => new Date(ts).toLocaleString();

export const DesktopPanel: React.FC<Props> = ({ isVisible, onClose }) => {
  const [tab, setTab] = useState<Tab>('folders');
  const [state, setState] = useState<DesktopState | null>(null);
  const [audit, setAudit] = useState<AuditEntryView[]>([]);
  const [journal, setJournal] = useState<JournalView[]>([]);
  const [msg, setMsg] = useState<string>('');

  const refresh = useCallback(async () => {
    if (!desktopClient.available()) return;
    const [s, a, j] = await Promise.all([
      desktopClient.state(),
      desktopClient.audit(200),
      desktopClient.journal(),
    ]);
    setState(s);
    setAudit(a);
    setJournal(j);
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    // 面板可见时初次拉取 + 订阅后端变更：属于外部数据同步，豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    return desktopClient.onChanged(() => void refresh());
  }, [isVisible, refresh]);

  if (!isVisible) return null;

  const grant = async (mode: 'read' | 'read-write') => {
    const s = await desktopClient.grant(mode);
    setMsg(s ? tr('ui.foundation.granted', s.path) : tr('ui.foundation.cancelled'));
    void refresh();
  };

  const undo = async () => {
    const r = await desktopClient.undoLast();
    setMsg(r.ok ? tr('ui.foundation.revoked', r.undone) : tr('ui.foundation.can-t-undo', r.error));
    void refresh();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('ui.foundation.desktop-abilities')}
      size="lg"
      data-testid="desktop-panel"
    >
      <div className={styles.stack}>
        <Notice icon={Lock}>
          {tr('ui.foundation.grants-permissions-and-the-activity-log-are-stored')}
        </Notice>
        <Tabs
          variant="underline"
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          items={[
            { value: 'folders', label: tr('ui.foundation.granted-folders') },
            { value: 'tools', label: tr('ui.foundation.tool-permissions') },
            { value: 'cloud', label: tr('ui.chat-settings.cloud-local-only') },
            { value: 'log', label: tr('ui.foundation.activity-log') },
          ]}
        />
        {msg && (
          <div className={styles.msg} data-testid="desktop-msg">
            {msg}
          </div>
        )}

        {tab === 'folders' && (
          <SettingsGroup
            title={tr('ui.knowledge-local.authorized-folders')}
            description={tr('ui.knowledge-local.by-default-nomi-can-t-see-any-of')}
            actions={
              <>
                <Button
                  size="sm"
                  onClick={() => void grant('read-write')}
                  data-testid="desktop-grant-rw"
                >
                  <Icon icon={Plus} size={14} />
                  {tr('ui.knowledge-local.authorize-read-write')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void grant('read')}
                  data-testid="desktop-grant-read"
                >
                  <Icon icon={Plus} size={14} />
                  {tr('ui.knowledge-local.authorize-read-only')}
                </Button>
              </>
            }
            data-testid="desktop-folders"
          >
            {state && state.scopes.length === 0 ? (
              <EmptyState
                icon={FolderLock}
                title={tr('ui.foundation.no-folders-granted-yet')}
                description={tr('ui.knowledge-local.once-authorized-nomi-can-only-read-and-write')}
              />
            ) : (
              state?.scopes.map((s) => (
                <SettingRow
                  key={s.id}
                  data-testid="desktop-scope"
                  title={<span className={styles.path}>{s.path}</span>}
                  description={tr(
                    'ui.session-workspace.message',
                    s.kind === 'file'
                      ? tr('ui.foundation.single-file')
                      : tr('ui.foundation.folder'),
                    fmt(s.grantedAt),
                  )}
                >
                  <Badge tone={s.mode === 'read-write' ? 'warning' : 'neutral'}>
                    {s.mode === 'read-write'
                      ? tr('ui.foundation.read-write')
                      : tr('ui.foundation.read-only')}
                  </Badge>
                  {s.session && <Badge>{tr('ui.foundation.this-session-only')}</Badge>}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void desktopClient.revoke(s.id)}
                    data-testid="desktop-revoke"
                  >
                    {tr('ui.foundation.revoke')}
                  </Button>
                </SettingRow>
              ))
            )}
          </SettingsGroup>
        )}

        {tab === 'tools' && state && (
          <SettingsGroup
            title={tr('ui.foundation.tool-permissions')}
            description={tr(
              'ui.knowledge-local.how-the-assistant-confirms-before-calling-each-tool',
            )}
          >
            <table className={`${styles.table} ${styles.toolsTable}`} data-testid="desktop-tools">
              <thead>
                <tr>
                  <th>{tr('ui.foundation.tool')}</th>
                  <th>{tr('ui.foundation.level')}</th>
                  <th>{tr('ui.foundation.confirmation')}</th>
                </tr>
              </thead>
              <tbody>
                {state.tools.map((t) => (
                  <tr key={t.name}>
                    <td>
                      {tr(TOOL_LABELS[t.name] ?? t.name)}
                      <div className={styles.code}>{tr(t.name)}</div>
                    </td>
                    <td>
                      <Badge
                        tone={
                          t.danger === 'destructive'
                            ? 'danger'
                            : t.danger === 'write'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {tr(DANGER_LABELS[t.danger])}
                      </Badge>
                    </td>
                    <td>
                      {t.danger === 'destructive' ? (
                        <span className={styles.hint}>
                          {tr('ui.foundation.confirm-in-a-dialog-every-time-cannot-be')}
                        </span>
                      ) : t.name === 'desktop_request_scope' ? (
                        <span className={styles.hint}>
                          {tr('ui.foundation.decided-by-you-in-the-system-folder-picker')}
                        </span>
                      ) : t.locked ? (
                        <span className={styles.hint}>
                          {tr('ui.foundation.ask-every-time-cannot-be-changed')}
                        </span>
                      ) : (
                        <Select
                          size="sm"
                          value={t.policy}
                          onChange={(e) =>
                            void desktopClient.setPolicy(t.name, e.target.value as Policy)
                          }
                          options={(['always', 'session', 'ask'] as Policy[]).map((p) => ({
                            value: p,
                            label: tr(POLICY_LABELS[p]),
                          }))}
                          data-testid={`desktop-policy-${t.name}`}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SettingsGroup>
        )}

        {tab === 'cloud' && state && (
          <div className={styles.stack} data-testid="desktop-cloud">
            <SettingsGroup title={tr('ui.knowledge-local.cloud-models')}>
              <SettingRow
                title={tr('ui.foundation.only-local-models-can-read-files')}
                description={tr('ui.foundation.when-on-only-local-models-e-g-ollama')}
              >
                <Switch
                  checked={state.localOnly}
                  onChange={(v) => void desktopClient.setLocalOnly(v)}
                  aria-label={tr('ui.foundation.only-local-models-can-read-files')}
                  data-testid="desktop-local-only"
                />
              </SettingRow>
              <SettingRow
                title={tr('ui.knowledge-local.cloud-models-allowed-to-read-files')}
                description={
                  <>
                    {tr('ui.knowledge-local.you-re-asked-the-first-time-file-contents')}{' '}
                    {state.cloudAcked.length
                      ? state.cloudAcked.map((p) => <Badge key={p}>{p}</Badge>)
                      : tr('ui.knowledge-local.none-yet')}
                  </>
                }
              >
                <Button
                  size="sm"
                  disabled={!state.cloudAcked.length}
                  onClick={() => void desktopClient.resetCloudAcks()}
                >
                  {tr('ui.foundation.ask-again')}
                </Button>
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title={tr('ui.voice-mascot.clear')}>
              <SettingRow
                title={tr('ui.knowledge-local.clear-all-desktop-capability-data')}
                description={tr(
                  'ui.knowledge-local.deletes-all-folder-authorizations-tool-permission-settings-and',
                )}
              >
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    if (
                      !window.confirm(
                        tr(
                          'ui.knowledge-local.clear-all-authorizations-permission-settings-and-activity-records',
                        ),
                      )
                    )
                      return;
                    void desktopClient
                      .resetAll()
                      .then(() => setMsg(tr('ui.foundation.all-desktop-ability-data-cleared')));
                  }}
                >
                  {tr('ui.knowledge-local.clear-all')}
                </Button>
              </SettingRow>
            </SettingsGroup>
          </div>
        )}

        {tab === 'log' && (
          <div className={styles.stack} data-testid="desktop-log">
            <SettingsGroup
              title={tr('ui.foundation.undoable-actions')}
              description={tr('ui.knowledge-local.file-changes-made-by-nomi-can-be-undone')}
              actions={
                <Button
                  size="sm"
                  onClick={() => void undo()}
                  disabled={!journal.some((j) => !j.undone)}
                  data-testid="desktop-undo"
                >
                  <Icon icon={Undo2} size={14} />
                  {tr('ui.chat-settings.undo-last-step')}
                </Button>
              }
            >
              {journal.length > 0 ? (
                <ul className={styles.list}>
                  {journal.map((j) => (
                    <li key={j.id} data-testid="desktop-journal-item">
                      {fmt(j.ts)} · {tr(j.summary)}{' '}
                      {j.undone && <Badge>{tr('ui.foundation.undone')}</Badge>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.hint}>{tr('ui.knowledge-local.nothing-to-undo-yet')}</p>
              )}
            </SettingsGroup>
            <SettingsGroup
              title={tr('ui.foundation.audit-log')}
              description={tr('ui.knowledge-local.time-result-and-arguments-of-every-desktop-tool')}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={audit.length === 0}
                  onClick={() => void desktopClient.clearAudit().then(refresh)}
                >
                  {tr('ui.foundation.clear-log')}
                </Button>
              }
            >
              {audit.length === 0 ? (
                <EmptyState icon={ScrollText} title={tr('ui.foundation.nothing-logged-yet')} />
              ) : (
                <table className={styles.table} data-testid="desktop-audit">
                  <thead>
                    <tr>
                      <th>{tr('ui.foundation.time')}</th>
                      <th>{tr('ui.foundation.action')}</th>
                      <th>{tr('ui.foundation.result')}</th>
                      <th>{tr('ui.foundation.arguments')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((a, i) => (
                      <tr key={`${a.ts}-${i}`} data-testid="desktop-audit-row">
                        <td>{fmt(a.ts)}</td>
                        <td>
                          {tr(TOOL_LABELS[a.tool] ?? a.tool)}
                          <div className={styles.code}>{a.source ?? ''}</div>
                        </td>
                        <td>
                          <Badge tone={a.result === 'ok' ? 'success' : 'danger'}>
                            {tr(DECISION_LABEL[a.decision] ?? a.decision)} · {a.result}
                          </Badge>
                        </td>
                        <td className={styles.code}>{JSON.stringify(a.args)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SettingsGroup>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default DesktopPanel;
