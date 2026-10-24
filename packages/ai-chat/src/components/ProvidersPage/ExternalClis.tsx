/**
 * 「编程助手 → 外部 CLI」：接入任意说 ACP（Agent Client Protocol）的 CLI（L1 声明式插件，
 * docs/design/cli-plugin-architecture.md §5.9）。只填命令、参数模板和需要的环境变量名，不加载任何第三方代码。
 * 「测试」只做 ACP 握手（不建会话、不发消息）；外部 CLI 没有官方账号、第三方模型与用量监视，
 * 权限只有「逐项确认」。
 */
import {
  Badge,
  Button,
  FormField,
  Input,
  Modal,
  Notice,
  SettingRow,
  SettingsGroup,
  t,
  Textarea,
} from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import {
  cliPluginClient,
  describeSpecError,
  idFromName,
  type CliRegistryEntry,
  type ExternalCliSpec,
  type ExternalTestResult,
} from '../../services/cliPluginClient';
import { harnessClient } from '../../services/harnessClient';

import styles from './index.module.css';

interface Draft {
  name: string;
  id: string;
  /** 用户改过 id：之后不再跟着名称变 */
  idTouched: boolean;
  command: string;
  /** 每行一个参数 */
  args: string;
  /** 逗号或空白分隔的变量名 */
  env: string;
}

const EMPTY: Draft = { name: '', id: '', idTouched: false, command: '', args: '', env: '' };

function toSpec(d: Draft): ExternalCliSpec {
  const env = d.env
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    version: 1,
    id: d.id.trim(),
    displayName: d.name.trim(),
    command: d.command.trim(),
    args: d.args
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean),
    ...(env.length ? { env } : {}),
  };
}

function fromSpec(s: ExternalCliSpec): Draft {
  return {
    name: s.displayName,
    id: s.id,
    idTouched: true,
    command: s.command,
    args: s.args.join('\n'),
    env: (s.env ?? []).join(', '),
  };
}

/** 展示用的命令行（只用来让人看懂会跑什么；实际启动不经 shell） */
const commandLine = (s: ExternalCliSpec) =>
  [s.command, ...s.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');

export const ExternalClis: React.FC<{ onOpenedTab?: () => void }> = ({ onOpenedTab }) => {
  const [list, setList] = useState<CliRegistryEntry[]>([]);
  const [editing, setEditing] = useState<{ draft: Draft; isNew: boolean } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [test, setTest] = useState<ExternalTestResult | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!cliPluginClient.available()) return;
    let alive = true;
    const apply = (s: { plugins: CliRegistryEntry[] }) =>
      alive && setList(s.plugins.filter((p) => !p.builtin));
    cliPluginClient
      .registry()
      .then(apply)
      .catch(() => undefined);
    const off = cliPluginClient.onRegistry(apply);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const open = (draft: Draft, isNew: boolean) => {
    setEditing({ draft, isNew });
    setErrors([]);
    setTest(null);
  };
  const patch = (p: Partial<Draft>) =>
    setEditing((e) => {
      if (!e) return e;
      const draft = { ...e.draft, ...p };
      if (p.name !== undefined && !draft.idTouched && e.isNew) draft.id = idFromName(p.name);
      return { ...e, draft };
    });

  const runTest = async () => {
    if (!editing) return;
    setBusy('test');
    setTest(null);
    setErrors([]);
    try {
      const r = await cliPluginClient.test(toSpec(editing.draft));
      if (r.ok) setTest(r);
      else setErrors(r.errors);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!editing) return;
    setBusy('save');
    try {
      const r = await cliPluginClient.add(toSpec(editing.draft));
      if (r.ok) setEditing(null);
      else setErrors(r.errors);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: CliRegistryEntry) => {
    if (
      !window.confirm(t('删除外部 CLI「{0}」？用它的标签会保留，但不能再发消息。', p.displayName))
    )
      return;
    setActionError(null);
    await cliPluginClient.remove(p.id).catch((e: unknown) => setActionError(String(e)));
  };

  const newTab = async (p: CliRegistryEntry) => {
    setActionError(null);
    try {
      await harnessClient.createTab({ backend: 'external', pluginId: p.id });
      onOpenedTab?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <SettingsGroup
      title={t('外部 CLI')}
      description={t(
        '接入任意支持 ACP（Agent Client Protocol）的编程助手。只保存命令、参数和环境变量名，不加载第三方代码。',
      )}
      actions={
        <Button size="sm" data-testid="external-cli-add" onClick={() => open(EMPTY, true)}>
          {t('添加 CLI')}
        </Button>
      }
      data-testid="external-clis"
    >
      {actionError && <Notice tone="danger">{actionError}</Notice>}
      {list.length === 0 && (
        <p className={styles.sub} data-testid="external-cli-empty">
          {t('还没有添加外部 CLI。')}
        </p>
      )}
      {list.map((p) => (
        <SettingRow
          key={p.id}
          data-testid={`external-cli-${p.id}`}
          title={
            <span className={styles.extTitle}>
              {p.displayName}
              {p.status === 'ready' ? (
                <Badge tone="success">{t('就绪')}</Badge>
              ) : (
                <Badge tone="danger">{t('清单无效')}</Badge>
              )}
            </span>
          }
          description={
            <>
              {p.external && <code className={styles.extCmd}>{commandLine(p.external)}</code>}
              {p.status !== 'ready' && p.errors.length > 0 && (
                <span className={styles.extWarn}>{p.errors.map(describeSpecError).join('；')}</span>
              )}
              {p.external?.missingEnv.length ? (
                <span className={styles.extWarn}>
                  {t('缺少环境变量：{0}', p.external.missingEnv.join(', '))}
                </span>
              ) : null}
            </>
          }
        >
          {p.status === 'ready' && (
            <Button size="sm" variant="primary" onClick={() => void newTab(p)}>
              {t('新建标签')}
            </Button>
          )}
          {p.external && (
            <Button size="sm" onClick={() => open(fromSpec(p.external!), false)}>
              {t('编辑')}
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            aria-label={t('删除 {0}', p.displayName)}
            onClick={() => void remove(p)}
          >
            {t('删除')}
          </Button>
        </SettingRow>
      ))}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.isNew ? t('添加外部 CLI') : t('编辑外部 CLI')}
        data-testid="external-cli-dialog"
        footer={
          <>
            <Button
              data-testid="external-cli-test"
              disabled={busy !== null}
              onClick={() => void runTest()}
            >
              {busy === 'test' ? t('测试中…') : t('测试')}
            </Button>
            <Button
              variant="primary"
              data-testid="external-cli-save"
              disabled={busy !== null}
              onClick={() => void save()}
            >
              {t('保存')}
            </Button>
          </>
        }
      >
        {editing && (
          <div className={styles.extForm}>
            <Notice tone="warning">
              {t(
                '外部 CLI 以你的身份在你的电脑上运行；只添加你信任的程序。Nomi 每次工具调用都会先问你（逐项确认）。',
              )}
            </Notice>
            <FormField label={t('名称')}>
              <Input
                value={editing.draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                data-testid="external-cli-name"
              />
            </FormField>
            <FormField label="id" hint={t('只能用小写字母、数字和 -；保存后作为标签与对话的标识')}>
              <Input
                value={editing.draft.id}
                disabled={!editing.isNew}
                onChange={(e) => patch({ id: e.target.value, idTouched: true })}
                data-testid="external-cli-id"
              />
            </FormField>
            <FormField label={t('命令')} hint={t('可执行文件的绝对路径，或 PATH 里的名字')}>
              <Input
                value={editing.draft.command}
                onChange={(e) => patch({ command: e.target.value })}
                data-testid="external-cli-command"
              />
            </FormField>
            <FormField
              label={t('参数')}
              hint={t(
                '每行一个；可用 {0}（工作目录）与 {1}（主目录）。不经 shell，不会展开变量或通配符。',
                '{cwd}',
                '{home}',
              )}
            >
              <Textarea
                rows={3}
                value={editing.draft.args}
                onChange={(e) => patch({ args: e.target.value })}
                data-testid="external-cli-args"
              />
            </FormField>
            <FormField
              label={t('需要的环境变量')}
              hint={t('只写名字（如 MY_TOKEN），值从启动 Nomi 的环境里继承，Nomi 不保存。')}
            >
              <Input
                value={editing.draft.env}
                onChange={(e) => patch({ env: e.target.value })}
                data-testid="external-cli-env"
              />
            </FormField>
            {errors.length > 0 && (
              <Notice tone="danger" data-testid="external-cli-errors">
                {errors.map(describeSpecError).join('；')}
              </Notice>
            )}
            {test?.ok && (
              <Notice tone="success" data-testid="external-cli-test-result">
                {t(
                  '握手成功：{0}{1}。支持续接：{2}；支持图片：{3}。',
                  test.agent.title ?? test.agent.name ?? t('未报告名称'),
                  test.agent.version ? ` ${test.agent.version}` : '',
                  test.capabilities.loadSession ? t('是') : t('否'),
                  test.capabilities.images ? t('是') : t('否'),
                )}
                {test.missingEnv.length > 0 && (
                  <span className={styles.extWarn}>
                    {t('缺少环境变量：{0}', test.missingEnv.join(', '))}
                  </span>
                )}
                {test.authMethods.length > 0 && (
                  <span className={styles.extWarn}>
                    {t('它需要先在终端里登录（{0}）。', test.authMethods.join(', '))}
                  </span>
                )}
              </Notice>
            )}
          </div>
        )}
      </Modal>
    </SettingsGroup>
  );
};
