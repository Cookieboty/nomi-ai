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
  { value: 'skip', label: tr('跳过') },
  { value: 'rename', label: tr('重命名导入') },
  { value: 'overwrite', label: tr('覆盖已有') },
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
          aria-label={tr('导入 {0}', it.name)}
          data-testid={`migrate-check-${it.key}`}
        />
        <b className={styles.grow}>{it.name}</b>
        <Badge tone="neutral">{TOOL_LABEL[it.tool]}</Badge>
        <Badge tone="neutral">{tr(SCOPE_LABEL[it.scope])}</Badge>
        {it.conflict && <Badge tone="accent">{tr('已有同名')}</Badge>}
        <button
          type="button"
          className={styles.expand}
          onClick={() => setExpanded(expanded === it.key ? null : it.key)}
          aria-expanded={expanded === it.key}
        >
          {tr('预览')}
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
            {it.kind === 'mcp' ? tr('Nomi 里已有同名服务器：') : tr('Nomi 里已有同名技能：')}
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
                  '文件：{0}（{1}）',
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
      title={tr('从其他工具导入')}
      data-testid="migrate-dialog"
      footer={
        <div className={styles.row}>
          <Button
            onClick={() => void doScan({ pickProject: true })}
            disabled={busy}
            data-testid="migrate-pick-project"
          >
            {scan?.project ? tr('更换项目文件夹…') : tr('添加项目文件夹…')}
          </Button>
          <span className={styles.grow} />
          <Button onClick={onClose}>{result ? tr('完成') : tr('取消')}</Button>
          {!result && (
            <Button
              variant="primary"
              disabled={busy || chosen.length === 0}
              onClick={() => void doImport()}
              data-testid="migrate-import"
            >
              {tr('导入所选（{0}）', chosen.length)}
            </Button>
          )}
        </div>
      }
    >
      <div className={styles.stack}>
        <p className={styles.hint}>
          {tr(
            '读取本机 Claude Code（~/.claude.json、.mcp.json、~/.claude/skills）和 Codex（~/.codex/config.toml、~/.agents/skills）的配置。MCP 服务器导入后默认不连接；密钥用系统安全存储加密保存；技能会复制一份到 Nomi 的技能文件夹，原文件不受影响。',
          )}
        </p>
        {scan?.project && (
          <p className={styles.hint}>
            {tr('项目文件夹：{0}', scan.project)}{' '}
            <button
              type="button"
              className={styles.expand}
              onClick={() => void doScan({ clearProject: true })}
            >
              {tr('移除')}
            </button>
          </p>
        )}
        {err && <Notice tone="danger">{err}</Notice>}
        {busy && !scan && <LoadingState rows={3} />}
        {result && (
          <Notice tone={result.failed.length ? 'warning' : 'success'} data-testid="migrate-result">
            {tr(
              '已导入 {0} 项，跳过 {1} 项，失败 {2} 项。',
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
                  ? tr('找到了配置文件，但里面没有可导入的 MCP 服务器或技能。')
                  : tr('没有找到 Claude Code 或 Codex 的配置。可以添加项目文件夹再试。')}
              </Notice>
            ) : (
              <div className={styles.list}>
                {scan.mcp.length > 0 && <b className={styles.hint}>{tr('MCP 服务器')}</b>}
                {scan.mcp.map(row)}
                {scan.skills.length > 0 && <b className={styles.hint}>{tr('技能')}</b>}
                {scan.skills.map(row)}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
