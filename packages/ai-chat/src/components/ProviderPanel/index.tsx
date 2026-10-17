/**
 * ProviderPanel —— 供应商管理：
 *   列表（当前徽标 / 一键切换 / 编辑 / 测速 / 删除）→ 添加（搜索 + 分类预设）→ 编辑（通用三协议表单）；
 *   任务路由：chat / agent-tools / summary 从各供应商已启用（或已获取）的模型里选。
 * 明文 key 只单向提交给主进程；界面只显示掩码。
 */
import { t, Icon } from '@nomi-ai/ui';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
  ModalHostContext,
  Notice,
  Select,
  ToastProvider,
} from '@nomi-ai/ui';
import { CloudCog, Plus, TriangleAlert, Zap } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  PROTOCOL_LABELS,
  endpointPreview,
  providerClient,
  selectableModels,
  selectableProviders,
  type ProviderPreset,
  type ProviderRole,
  type ProviderState,
  type ProviderView,
  type TestResult,
} from '../../services/providerClient';

import { AddProvider } from './AddProvider';
import styles from './index.module.css';
import { ProviderEditor, type EditorTarget } from './ProviderEditor';
import { Monogram, TestBadge, fmt } from './shared';

interface Props {
  isVisible: boolean;
  onClose: () => void;
}

const ROLE_LABELS: Record<ProviderRole, string> = {
  chat: '对话 chat',
  'agent-tools': '工具 agent-tools',
  summary: '摘要 summary',
};

type View = { kind: 'list' } | { kind: 'add' } | { kind: 'edit'; target: EditorTarget };

const ProviderRow: React.FC<{
  p: ProviderView;
  current: boolean;
  locked: boolean;
  onEdit: () => void;
  onError: (e: unknown) => void;
}> = ({ p, current, locked, onEdit, onError }) => {
  const [test, setTest] = useState<TestResult | 'pending'>();
  const run = (fn: () => Promise<unknown>) => () => void fn().catch(onError);
  return (
    <Card
      active={current}
      className={styles.card}
      data-testid={`provider-card-${p.id}`}
      title={
        <span className={styles.inline}>
          <Monogram name={t(p.name)} brand={p.presetId} size={28} />
          <span>{t(p.name)}</span>
          {current && <Badge data-testid="current-badge">{t('当前')}</Badge>}
          {!p.enabled && <Badge tone="neutral">{t('已停用')}</Badge>}
          {p.note && <span className="cd-muted">{p.note}</span>}
        </span>
      }
      subtitle={
        <span>
          {t(PROTOCOL_LABELS[p.protocol])} ·{' '}
          <code className="cd-code">{endpointPreview(p.protocol, p.baseURL, p.fullUrl)}</code> ·{' '}
          {p.defaultModel}
          {p.models.length > 1 && t(' 等 {0} 个模型', p.models.length)}
        </span>
      }
      actions={
        <>
          <TestBadge r={test} />
          {!current && (
            <Button
              size="sm"
              variant="primary"
              disabled={locked}
              data-testid={`activate-${p.id}`}
              onClick={run(() => providerClient.setActive(p.id))}
            >
              {t('启用')}
            </Button>
          )}
          <Button
            size="sm"
            data-testid={`speed-${p.id}`}
            onClick={run(async () => {
              setTest('pending');
              setTest(await providerClient.test(p.id));
            })}
          >
            <Icon icon={Zap} size={14} />
            {t('测速')}
          </Button>
          <Button size="sm" data-testid={`edit-${p.id}`} onClick={onEdit}>
            {t('编辑')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={run(async () => {
              if (window.confirm(t('删除供应商「{0}」及其所有 Token？', p.name)))
                await providerClient.remove(p.id);
            })}
          >
            {t('删除')}
          </Button>
        </>
      }
    >
      <div className="cd-muted" data-testid={`usage-${p.id}`}>
        {p.keys.length > 0
          ? `Token ${p.keys[0]!.masked}${p.keys.length > 1 ? ` +${p.keys.length - 1}` : ''}`
          : t('无 Token')}{' '}
        {t('· 用量（本地统计）：')}
        {p.usage.requests} {t('次请求 · 输入')} {fmt(p.usage.inputTokens)} {t('· 输出')}{' '}
        {fmt(p.usage.outputTokens)} tokens
        {p.usage.errors ? t(' · {0} 次失败', p.usage.errors) : ''}
      </div>
    </Card>
  );
};

const RoutesTable: React.FC<{ state: ProviderState; onError: (e: unknown) => void }> = ({
  state,
  onError,
}) => {
  const options = selectableProviders(state);
  return (
    <table className="cd-table" data-testid="routes-table">
      <thead>
        <tr>
          <th>{t('任务')}</th>
          <th>{t('供应商')}</th>
          <th>{t('模型')}</th>
        </tr>
      </thead>
      <tbody>
        {state.roles.map((role) => {
          const r = state.routes[role];
          const models = selectableModels(state, r?.providerId);
          return (
            <tr key={role}>
              <td>{t(ROLE_LABELS[role])}</td>
              <td>
                <Select
                  size="sm"
                  data-testid={`route-${role}`}
                  value={r?.providerId ?? ''}
                  onChange={(e) =>
                    void providerClient
                      .setRoute(role, e.target.value ? { providerId: e.target.value } : null)
                      .catch(onError)
                  }
                  menuMinWidth={220}
                  options={[
                    { value: '', label: t('跟随当前') },
                    ...options.map((o) => ({
                      value: o.id,
                      label: o.label,
                      disabled: o.disabled,
                      group: o.group,
                      icon: <Monogram name={t(o.label)} brand={o.brand} size={18} />,
                    })),
                  ]}
                />
              </td>
              <td>
                <Select
                  size="sm"
                  data-testid={`route-model-${role}`}
                  disabled={!r}
                  value={r?.model ?? ''}
                  onChange={(e) =>
                    r &&
                    void providerClient
                      .setRoute(role, {
                        providerId: r.providerId,
                        model: e.target.value || undefined,
                      })
                      .catch(onError)
                  }
                  menuMinWidth={220}
                  options={[
                    { value: '', label: t('默认模型') },
                    ...models.map((m) => ({ value: m, label: m })),
                  ]}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

export const ProviderPanel: React.FC<Props> = ({ isVisible, onClose }) => {
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [state, setState] = useState<ProviderState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  // 使用 setState-during-render 模式：面板从隐藏切到可见时，渲染期同步重置视图回「列表」
  const [lastVisibleKey, setLastVisibleKey] = useState(isVisible);
  if (lastVisibleKey !== isVisible) {
    setLastVisibleKey(isVisible);
    if (isVisible && view.kind !== 'list') setView({ kind: 'list' });
  }

  const onError = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const [ps, st] = await Promise.all([providerClient.presets(), providerClient.state()]);
      setPresets(ps);
      setState(st);
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    if (!isVisible) return;
    // 面板可见时初次拉取 + 订阅后端变更：属于外部数据同步，豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    return providerClient.onChanged((s) => setState(s));
  }, [isVisible, refresh]);

  if (!isVisible) return null;
  const locked = Boolean(state?.overrideId);
  const current = state?.effectiveProviderId;
  return (
    <ToastProvider>
      <Modal
        open
        onClose={onClose}
        title={t('AI 供应商')}
        size="lg"
        data-testid="provider-panel"
        bodyClassName={styles.modalBody}
      >
        <div className={styles.stack}>
          {error && (
            <Notice
              tone="danger"
              onClick={() => setError(null)}
              title={t('点击关闭')}
              data-testid="provider-error"
            >
              {error}
            </Notice>
          )}
          {state?.encryption === 'none' && (
            <Notice tone="warning" icon={TriangleAlert} data-testid="encryption-warning">
              {t(
                '当前系统不支持安全存储（safeStorage 不可用），Token 仅以编码形式保存在本机，未加密。',
              )}
            </Notice>
          )}
          {locked && (
            <Notice tone="warning">
              {t('环境变量 NOMI_PROVIDER=')}
              {state!.overrideId} {t('已锁定对话供应商，此处切换不会生效。')}
            </Notice>
          )}

          {state && (
            <>
              <div className={styles.inline}>
                <span className="cd-muted">
                  {t('当前：')}
                  <b data-testid="current-provider">
                    {selectableProviders(state).find((o) => o.id === current)?.label ?? t('未选择')}
                  </b>
                  {state.effectiveModel && (
                    <>
                      {' '}
                      · <span data-testid="current-model">{state.effectiveModel}</span>
                    </>
                  )}
                </span>
                <span className="cd-spacer" />
                <Button
                  variant="primary"
                  data-testid="add-provider-btn"
                  onClick={() => setView({ kind: 'add' })}
                >
                  <Icon icon={Plus} size={14} />
                  {t('添加供应商')}
                </Button>
              </div>
              {state.providers.length + state.envProviders.length === 0 && (
                <EmptyState
                  icon={CloudCog}
                  title={t('还没有供应商')}
                  description={t('点「添加供应商」，选择预设或自定义配置')}
                />
              )}
              {state.providers.map((p) => (
                <ProviderRow
                  key={p.id}
                  p={p}
                  current={current === p.id}
                  locked={locked}
                  onEdit={() => setView({ kind: 'edit', target: { kind: 'edit', provider: p } })}
                  onError={onError}
                />
              ))}
              {state.envProviders
                .filter((e) => e.hasKey)
                .map((e) => (
                  <Card
                    key={e.id}
                    flat
                    active={current === e.id}
                    title={
                      <span className={styles.inline}>
                        <Monogram name={t(e.name)} brand={e.id} size={28} />
                        {t(e.name)}
                        {current === e.id && <Badge>{t('当前')}</Badge>}
                      </span>
                    }
                    subtitle={t(
                      '{0} · {1} · {2} · {3}',
                      PROTOCOL_LABELS[e.protocol],
                      e.baseURL ?? '',
                      e.defaultModel ?? '',
                      e.keyless
                        ? t('本地服务，无需 key')
                        : e.hasKey
                          ? t('key 由环境变量提供')
                          : t('未设置 key'),
                    )}
                    actions={
                      current !== e.id && e.hasKey ? (
                        <Button
                          size="sm"
                          disabled={locked}
                          onClick={() => void providerClient.setActive(e.id).catch(onError)}
                        >
                          {t('启用')}
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
              <section>
                <h3 className="cd-section-title">{t('任务路由（可选，默认都跟随当前供应商）')}</h3>
                <RoutesTable state={state} onError={onError} />
                <p className="cd-muted">
                  {t(
                    '优先级：NOMI_PROVIDER 环境变量 → 任务路由 → 当前供应商。工具栏 / 托盘一键切换会让「对话」立即改用所选供应商。',
                  )}
                </p>
              </section>
            </>
          )}
        </div>
      </Modal>

      {(view.kind === 'add' || view.kind === 'edit') && (
        <ModalHostContext.Provider value={{ mode: 'drawer' }}>
          <Modal
            open
            onClose={() => setView({ kind: 'list' })}
            title={
              view.kind === 'add'
                ? t('添加供应商')
                : view.target.kind === 'edit'
                  ? t('供应商设置')
                  : t('添加 {0}', view.target.preset.name)
            }
            size="lg"
            data-testid="provider-drawer"
            bodyClassName={styles.drawerBody}
          >
            {view.kind === 'add' && (
              <AddProvider
                presets={presets}
                onPick={(p) => setView({ kind: 'edit', target: { kind: 'new', preset: p } })}
              />
            )}
            {view.kind === 'edit' && (
              <ProviderEditor
                key={
                  view.target.kind === 'edit'
                    ? view.target.provider.id
                    : `new-${view.target.preset.id}`
                }
                target={view.target}
                isActive={view.target.kind === 'edit' && view.target.provider.id === current}
                onBack={() =>
                  setView(view.target.kind === 'new' ? { kind: 'add' } : { kind: 'list' })
                }
                onSaved={(result) => {
                  setError(null);
                  if (result.pickModel) {
                    setView({ kind: 'edit', target: { kind: 'edit', provider: result.provider } });
                  } else {
                    setView({ kind: 'list' });
                  }
                }}
                onError={onError}
              />
            )}
          </Modal>
        </ModalHostContext.Provider>
      )}
    </ToastProvider>
  );
};
