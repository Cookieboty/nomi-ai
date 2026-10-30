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
import { confirmDialog } from '../ConfirmDialog';

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
      !(await confirmDialog({
        message: t('ui.providers-schedule.delete-the-external-cli-tabs-that-use-it', p.displayName),
        danger: true,
      }))
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
      title={t('ui.providers-schedule.external-cli')}
      description={t('ui.providers-schedule.connect-any-coding-assistant-that-speaks-acp-agent')}
      actions={
        <Button size="sm" data-testid="external-cli-add" onClick={() => open(EMPTY, true)}>
          {t('ui.providers-schedule.add-cli')}
        </Button>
      }
      data-testid="external-clis"
    >
      {actionError && <Notice tone="danger">{actionError}</Notice>}
      {list.length === 0 && (
        <p className={styles.sub} data-testid="external-cli-empty">
          {t('ui.providers-schedule.no-external-clis-added-yet')}
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
                <Badge tone="success">{t('ui.providers-schedule.ready')}</Badge>
              ) : (
                <Badge tone="danger">{t('ui.providers-schedule.invalid-manifest')}</Badge>
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
                  {t(
                    'ui.providers-schedule.missing-environment-variables',
                    p.external.missingEnv.join(', '),
                  )}
                </span>
              ) : null}
            </>
          }
        >
          {p.status === 'ready' && (
            <Button size="sm" variant="primary" onClick={() => void newTab(p)}>
              {t('ui.providers-schedule.new-tab')}
            </Button>
          )}
          {p.external && (
            <Button size="sm" onClick={() => open(fromSpec(p.external!), false)}>
              {t('ui.foundation.edit')}
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            aria-label={t('ui.knowledge-local.delete', p.displayName)}
            onClick={() => void remove(p)}
          >
            {t('ui.foundation.delete')}
          </Button>
        </SettingRow>
      ))}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={
          editing?.isNew
            ? t('ui.providers-schedule.add-external-cli')
            : t('ui.providers-schedule.edit-external-cli')
        }
        data-testid="external-cli-dialog"
        footer={
          <>
            <Button
              data-testid="external-cli-test"
              disabled={busy !== null}
              onClick={() => void runTest()}
            >
              {busy === 'test' ? t('ui.foundation.testing') : t('ui.providers-schedule.test')}
            </Button>
            <Button
              variant="primary"
              data-testid="external-cli-save"
              disabled={busy !== null}
              onClick={() => void save()}
            >
              {t('ui.foundation.save')}
            </Button>
          </>
        }
      >
        {editing && (
          <div className={styles.extForm}>
            <Notice tone="warning">
              {t('ui.providers-schedule.an-external-cli-runs-on-your-computer-as')}
            </Notice>
            <FormField label={t('ui.foundation.name')}>
              <Input
                value={editing.draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                data-testid="external-cli-name"
              />
            </FormField>
            <FormField
              label="id"
              hint={t('ui.providers-schedule.lowercase-letters-digits-and-only-after-saving-it')}
            >
              <Input
                value={editing.draft.id}
                disabled={!editing.isNew}
                onChange={(e) => patch({ id: e.target.value, idTouched: true })}
                data-testid="external-cli-id"
              />
            </FormField>
            <FormField
              label={t('ui.foundation.command')}
              hint={t('ui.providers-schedule.absolute-path-of-the-executable-or-a-name')}
            >
              <Input
                value={editing.draft.command}
                onChange={(e) => patch({ command: e.target.value })}
                data-testid="external-cli-command"
              />
            </FormField>
            <FormField
              label={t('ui.foundation.arguments')}
              hint={t(
                'ui.providers-schedule.one-per-line-you-can-use-working-folder',
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
              label={t('ui.providers-schedule.required-environment-variables')}
              hint={t('ui.providers-schedule.names-only-such-as-my-token-values-are')}
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
                  'ui.providers-schedule.handshake-succeeded-resume-images',
                  test.agent.title ??
                    test.agent.name ??
                    t('ui.providers-schedule.no-name-reported'),
                  test.agent.version ? ` ${test.agent.version}` : '',
                  test.capabilities.loadSession
                    ? t('ui.providers-schedule.yes')
                    : t('ui.providers-schedule.no'),
                  test.capabilities.images
                    ? t('ui.providers-schedule.yes')
                    : t('ui.providers-schedule.no'),
                )}
                {test.missingEnv.length > 0 && (
                  <span className={styles.extWarn}>
                    {t(
                      'ui.providers-schedule.missing-environment-variables',
                      test.missingEnv.join(', '),
                    )}
                  </span>
                )}
                {test.authMethods.length > 0 && (
                  <span className={styles.extWarn}>
                    {t(
                      'ui.providers-schedule.sign-in-to-it-in-a-terminal-first',
                      test.authMethods.join(', '),
                    )}
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
