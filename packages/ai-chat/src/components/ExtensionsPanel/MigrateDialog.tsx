/**
 * 「从其他工具导入」（#58）：扫描 Claude Code / Codex 的 MCP 服务器与技能，预览、勾选后导入。
 * 同名冲突逐项选择 跳过 / 重命名 / 覆盖。路径与密钥都只在主进程里，这里只拿到脱敏预览和 key。
 */
import { Badge, Button, LoadingState, Modal, Notice, Select, t as tr } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import {
  SCOPE_LABEL,
  TOOL_LABEL,
  extClient,
  type MigrateAction,
  type MigrateImportResult,
  type MigrateMcpItem,
  type MigrateScanResult,
  type MigrateSkillItem,
} from '../../services/extClient';

import styles from './index.module.css';

type Item = MigrateMcpItem | MigrateSkillItem;

const ACTIONS = (): Array<{ value: MigrateAction; label: string }> => [
  { value: 'skip', label: tr('ui.foundation.skip') },
  { value: 'rename', label: tr('ui.foundation.import-with-a-new-name') },
  { value: 'overwrite', label: tr('ui.foundation.overwrite-existing') },
];

const kb = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);

export const MigrateDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}> = ({ open, onClose, onDone }) => {
  const [scan, setScan] = useState<MigrateScanResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [actions, setActions] = useState<Record<string, MigrateAction>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [result, setResult] = useState<MigrateImportResult | null>(null);

  const doScan = useCallback(async (o: { pickProject?: boolean; clearProject?: boolean } = {}) => {
    setBusy(true);
    setErr('');
    try {
      const r = await extClient.migrateScan(o);
      setScan(r);
      // 默认勾选：没有错误、也没有同名冲突的项
      const p: Record<string, boolean> = {};
      for (const it of [...r.mcp, ...r.skills]) p[it.key] = !it.error && !it.conflict;
      setPicked(p);
      setActions({});
      setResult(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // 打开时扫描一次（外部数据同步）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void doScan();
  }, [open, doScan]);

  const items: Item[] = scan ? [...scan.mcp, ...scan.skills] : [];
  const chosen = items.filter((i) => picked[i.key] && !i.error);

  const doImport = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await extClient.migrateImport(
        chosen.map((i) => ({
          key: i.key,
          action: i.conflict ? (actions[i.key] ?? 'skip') : undefined,
        })),
      );
      setResult(r);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (it: Item) => (
    <div key={it.key} className={styles.card} data-testid={`migrate-item-${it.key}`}>
      <div className={styles.cardHead}>
        <input
          type="checkbox"
          checked={!!picked[it.key] && !it.error}
          disabled={!!it.error}
          onChange={(e) => setPicked({ ...picked, [it.key]: e.target.checked })}
          aria-label={tr('ui.foundation.import-named', it.name)}
          data-testid={`migrate-check-${it.key}`}
        />
        <b className={styles.grow}>{it.name}</b>
        <Badge tone="neutral">{TOOL_LABEL[it.tool]}</Badge>
        <Badge tone="neutral">{tr(SCOPE_LABEL[it.scope])}</Badge>
        {it.conflict && <Badge tone="accent">{tr('ui.foundation.name-taken')}</Badge>}
        <button
          type="button"
          className={styles.expand}
          onClick={() => setExpanded(expanded === it.key ? null : it.key)}
          aria-expanded={expanded === it.key}
        >
          {tr('ui.foundation.preview')}
        </button>
      </div>
      <div className={styles.meta}>{it.where}</div>
      {it.error && <div className={styles.err}>{it.error}</div>}
      {it.warnings.map((w) => (
        <div key={w} className={styles.hint}>
          · {w}
        </div>
      ))}
      {it.conflict && picked[it.key] && !it.error && (
        <div className={styles.row}>
          <span className={styles.hint}>
            {it.kind === 'mcp'
              ? tr('ui.foundation.nomi-already-has-a-server-with-this-name')
              : tr('ui.foundation.nomi-already-has-a-skill-with-this-name')}
          </span>
          <div className={styles.selectBox}>
            <Select
              size="sm"
              value={actions[it.key] ?? 'skip'}
              options={ACTIONS()}
              onChange={(e) =>
                setActions({ ...actions, [it.key]: e.target.value as MigrateAction })
              }
              data-testid={`migrate-action-${it.key}`}
            />
          </div>
        </div>
      )}
      {expanded === it.key && (
        <pre className={styles.meta} data-testid={`migrate-preview-${it.key}`}>
          {it.kind === 'mcp'
            ? JSON.stringify(it.preview ?? {}, null, 2)
            : [
                it.preview.description,
                '',
                tr(
                  'ui.foundation.files',
                  ['SKILL.md', ...it.preview.files].join('、'),
                  kb(it.preview.bytes),
                ),
              ].join('\n')}
        </pre>
      )}
    </div>
  );

  const found = scan?.sources.filter((s) => s.found) ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={tr('ui.foundation.import-from-other-tools')}
      data-testid="migrate-dialog"
      footer={
        <div className={styles.row}>
          <Button
            onClick={() => void doScan({ pickProject: true })}
            disabled={busy}
            data-testid="migrate-pick-project"
          >
            {scan?.project
              ? tr('ui.foundation.change-project-folder')
              : tr('ui.foundation.add-project-folder')}
          </Button>
          <span className={styles.grow} />
          <Button onClick={onClose}>
            {result ? tr('ui.usage-tools.done') : tr('ui.foundation.cancel')}
          </Button>
          {!result && (
            <Button
              variant="primary"
              disabled={busy || chosen.length === 0}
              onClick={() => void doImport()}
              data-testid="migrate-import"
            >
              {tr('ui.foundation.import-selected', chosen.length)}
            </Button>
          )}
        </div>
      }
    >
      <div className={styles.stack}>
        <p className={styles.hint}>
          {tr('ui.foundation.reads-your-local-claude-code-claude-json-mcp')}
        </p>
        {scan?.project && (
          <p className={styles.hint}>
            {tr('ui.foundation.project-folder', scan.project)}{' '}
            <button
              type="button"
              className={styles.expand}
              onClick={() => void doScan({ clearProject: true })}
            >
              {tr('ui.knowledge-local.remove')}
            </button>
          </p>
        )}
        {err && <Notice tone="danger">{err}</Notice>}
        {busy && !scan && <LoadingState rows={3} />}
        {result && (
          <Notice tone={result.failed.length ? 'warning' : 'success'} data-testid="migrate-result">
            {tr(
              'ui.foundation.imported-skipped-failed',
              result.imported.length,
              result.skipped.length,
              result.failed.length,
            )}
            {result.failed.map((f) => (
              <div key={f.key}>
                {f.name}：{f.error}
              </div>
            ))}
          </Notice>
        )}
        {scan && !result && (
          <>
            {scan.sources
              .filter((s) => s.error)
              .map((s) => (
                <div key={s.where} className={styles.err}>
                  {s.where}：{s.error}
                </div>
              ))}
            {items.length === 0 ? (
              <Notice tone="info" data-testid="migrate-empty">
                {found.length
                  ? tr('ui.foundation.found-config-files-but-there-are-no-mcp')
                  : tr('ui.foundation.no-claude-code-or-codex-settings-found-try')}
              </Notice>
            ) : (
              <div className={styles.list}>
                {scan.mcp.length > 0 && (
                  <b className={styles.hint}>{tr('ui.foundation.mcp-servers-label')}</b>
                )}
                {scan.mcp.map(row)}
                {scan.skills.length > 0 && (
                  <b className={styles.hint}>{tr('ui.foundation.skills-label')}</b>
                )}
                {scan.skills.map(row)}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
