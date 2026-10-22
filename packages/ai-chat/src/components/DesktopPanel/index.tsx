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
  auto: '自动',
  allowed: '已允许',
  denied: '已拒绝',
  timeout: '超时拒绝',
  user: '用户操作',
  error: '失败',
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
    setMsg(s ? tr('已授权：{0}', s.path) : tr('已取消'));
    void refresh();
  };

  const undo = async () => {
    const r = await desktopClient.undoLast();
    setMsg(r.ok ? tr('已撤销：{0}', r.undone) : tr('无法撤销：{0}', r.error));
    void refresh();
  };

  return (
    <Modal open onClose={onClose} title={tr('桌面能力')} size="lg" data-testid="desktop-panel">
      <div className={styles.stack}>
        <Notice icon={Lock}>
          {tr(
            '授权、权限、操作记录都只保存在本机。Nomi 只能访问你在这里授权的文件夹；删除一律进回收站，可撤销。',
          )}
        </Notice>
        <Tabs
          variant="underline"
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          items={[
            { value: 'folders', label: tr('授权文件夹') },
            { value: 'tools', label: tr('工具权限') },
            { value: 'cloud', label: tr('云端与仅本地') },
            { value: 'log', label: tr('操作记录') },
          ]}
        />
        {msg && (
          <div className={styles.msg} data-testid="desktop-msg">
            {msg}
          </div>
        )}

        {tab === 'folders' && (
          <SettingsGroup
            title={tr('已授权的文件夹')}
            description={tr(
              '默认 Nomi 看不到你的任何文件。始终拒绝：.ssh / .gnupg / 云凭据 / 浏览器配置 / 钥匙串 / *.kdbx / id_rsa / .env 等，以及应用自己的数据目录。',
            )}
            actions={
              <>
                <Button
                  size="sm"
                  onClick={() => void grant('read-write')}
                  data-testid="desktop-grant-rw"
                >
                  <Icon icon={Plus} size={14} />
                  {tr('授权（读写）')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void grant('read')}
                  data-testid="desktop-grant-read"
                >
                  <Icon icon={Plus} size={14} />
                  {tr('授权（只读）')}
                </Button>
              </>
            }
            data-testid="desktop-folders"
          >
            {state && state.scopes.length === 0 ? (
              <EmptyState
                icon={FolderLock}
                title={tr('还没有授权任何文件夹')}
                description={tr('授权后，Nomi 只能在这些文件夹里读写。')}
              />
            ) : (
              state?.scopes.map((s) => (
                <SettingRow
                  key={s.id}
                  data-testid="desktop-scope"
                  title={<span className={styles.path}>{s.path}</span>}
                  description={tr(
                    '{0} · {1}',
                    s.kind === 'file' ? tr('单个文件') : tr('文件夹'),
                    fmt(s.grantedAt),
                  )}
                >
                  <Badge tone={s.mode === 'read-write' ? 'warning' : 'neutral'}>
                    {s.mode === 'read-write' ? tr('读写') : tr('只读')}
                  </Badge>
                  {s.session && <Badge>{tr('仅本次运行')}</Badge>}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void desktopClient.revoke(s.id)}
                    data-testid="desktop-revoke"
                  >
                    {tr('撤销授权')}
                  </Button>
                </SettingRow>
              ))
            )}
          </SettingsGroup>
        )}

        {tab === 'tools' && state && (
          <SettingsGroup
            title={tr('工具权限')}
            description={tr('助手调用每个工具前怎么确认；破坏性操作每次都要你确认。')}
          >
            <table className={`${styles.table} ${styles.toolsTable}`} data-testid="desktop-tools">
              <thead>
                <tr>
                  <th>{tr('工具')}</th>
                  <th>{tr('级别')}</th>
                  <th>{tr('确认方式')}</th>
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
                          {tr('每次都需在对话框中确认（不可更改）')}
                        </span>
                      ) : t.name === 'desktop_request_scope' ? (
                        <span className={styles.hint}>{tr('由你在系统文件夹选择框中决定')}</span>
                      ) : t.locked ? (
                        <span className={styles.hint}>{tr('每次都询问（不可更改）')}</span>
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
            <SettingsGroup title={tr('云端模型')}>
              <SettingRow
                title={tr('仅本地模型可读文件')}
                description={tr(
                  '开启后，只有本机模型（如 Ollama，地址为 localhost）才能读取 / 总结文件内容；云端模型调用文件工具会被拒绝。',
                )}
              >
                <Switch
                  checked={state.localOnly}
                  onChange={(v) => void desktopClient.setLocalOnly(v)}
                  aria-label={tr('仅本地模型可读文件')}
                  data-testid="desktop-local-only"
                />
              </SettingRow>
              <SettingRow
                title={tr('已确认可读文件的云端模型')}
                description={
                  <>
                    {tr('第一次把文件内容发给某个云端模型时会弹出提示。')}{' '}
                    {state.cloudAcked.length
                      ? state.cloudAcked.map((p) => <Badge key={p}>{p}</Badge>)
                      : tr('目前没有。')}
                  </>
                }
              >
                <Button
                  size="sm"
                  disabled={!state.cloudAcked.length}
                  onClick={() => void desktopClient.resetCloudAcks()}
                >
                  {tr('重新提示')}
                </Button>
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title={tr('清除')}>
              <SettingRow
                title={tr('清除全部桌面能力数据')}
                description={tr('删除所有文件夹授权、工具权限设置与操作记录，无法撤销。')}
              >
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    if (!window.confirm(tr('清除全部授权、权限设置与操作记录？'))) return;
                    void desktopClient.resetAll().then(() => setMsg(tr('已清除全部桌面能力数据')));
                  }}
                >
                  {tr('清除全部')}
                </Button>
              </SettingRow>
            </SettingsGroup>
          </div>
        )}

        {tab === 'log' && (
          <div className={styles.stack} data-testid="desktop-log">
            <SettingsGroup
              title={tr('可撤销的操作')}
              description={tr('Nomi 改动过的文件可以一步步撤销；删除的文件都在回收站里。')}
              actions={
                <Button
                  size="sm"
                  onClick={() => void undo()}
                  disabled={!journal.some((j) => !j.undone)}
                  data-testid="desktop-undo"
                >
                  <Icon icon={Undo2} size={14} />
                  {tr('撤销上一步')}
                </Button>
              }
            >
              {journal.length > 0 ? (
                <ul className={styles.list}>
                  {journal.map((j) => (
                    <li key={j.id} data-testid="desktop-journal-item">
                      {fmt(j.ts)} · {tr(j.summary)} {j.undone && <Badge>{tr('已撤销')}</Badge>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.hint}>{tr('还没有可撤销的操作。')}</p>
              )}
            </SettingsGroup>
            <SettingsGroup
              title={tr('审计日志')}
              description={tr('每次调用桌面工具的时间、结果与参数。')}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={audit.length === 0}
                  onClick={() => void desktopClient.clearAudit().then(refresh)}
                >
                  {tr('清空记录')}
                </Button>
              }
            >
              {audit.length === 0 ? (
                <EmptyState icon={ScrollText} title={tr('还没有记录')} />
              ) : (
                <table className={styles.table} data-testid="desktop-audit">
                  <thead>
                    <tr>
                      <th>{tr('时间')}</th>
                      <th>{tr('操作')}</th>
                      <th>{tr('结果')}</th>
                      <th>{tr('参数')}</th>
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
