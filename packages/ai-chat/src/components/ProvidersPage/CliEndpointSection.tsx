/**
 * 单个 CLI 端点（Claude Code / Codex / dsh）的页面：
 * 说明（写到哪里、与其它端点独立）→ 版本卡片（检测 / 更新 / 安装）→ 供应商（与 Nomi 同样的卡片列表 +
 * 添加（预设模板）/ 编辑 / 启用 / 测速 / 删除；默认「使用 CLI 自带登录/默认配置」）→「高级」（本地路由、存储路径）。
 */
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
  ModalHostContext,
  Notice,
  ToastProvider,
  t,
  Icon,
} from '@nomi-ai/ui';
import { CloudCog, Plus, Zap } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  cliProviderClient,
  cliRouteClient,
  type CliProfileTestResult,
  type CliProviderKind,
  type CliProviderProfile,
  type CliProviderState,
  type CliRouteSettings,
} from '../../services/cliProviderClient';
import {
  providerClient,
  providerClientAvailable,
  type ProviderPreset,
} from '../../services/providerClient';
import { EndpointIcon } from '../EndpointIcon';
import { AddProvider } from '../ProviderPanel/AddProvider';
import ppStyles from '../ProviderPanel/index.module.css';
import { Monogram } from '../ProviderPanel/shared';

import { inferBrand } from './cliBrand';
import { CLI_FORMATS, CliProviderEditor, type CliEditorTarget } from './CliProviderEditor';
import { CliVersionCard } from './CliVersionCard';
import styles from './index.module.css';

const FORMATS = CLI_FORMATS;
const NAME: Record<CliProviderKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'dsh',
  grok: 'Grok',
};

/** 本地没有预设服务（非桌面环境）时，添加页至少有「自定义配置」 */
const CUSTOM_PRESET: ProviderPreset = {
  id: 'custom',
  name: '自定义配置',
  category: 'custom',
  protocol: 'openai-chat',
  baseURL: '',
  defaultModel: '',
  models: [],
  requiresApiKey: false,
  hint: '手动填写请求地址和 API Key',
};

export function formatLabel(kind: CliProviderKind, f: string): string {
  const hit = FORMATS[kind].find((x) => x.value === f)?.label ?? f;
  return t(hit)
    .replace(/[（(](原生|需开启路由|native|requires routing)[）)]/i, '')
    .trim();
}

/** 路由状态与原因（纯函数，便于测试） */
export function routingStatus(
  kind: CliProviderKind,
  active: CliProviderProfile | null,
  route: CliRouteSettings | null,
): { mode: 'none' | 'direct' | 'routed' | 'blocked' | 'n/a'; text: string } {
  if (kind === 'dsh') return { mode: 'n/a', text: t('无需路由：dsh 原生支持三种上游协议') };
  if (kind === 'grok') return { mode: 'n/a', text: t('无需路由：Grok 原生支持三种上游协议') };
  if (!active) return { mode: 'none', text: t('—（沿用 CLI 自带配置，不经过 Nomi）') };
  if (!active.needsRouting) {
    return {
      mode: 'direct',
      text: t(
        '直连：上游格式「{0}」是 {1} 的原生格式，无需路由',
        formatLabel(kind, active.apiFormat),
        NAME[kind],
      ),
    };
  }
  const on = Boolean(route?.enabled && route[kind]);
  return on
    ? {
        mode: 'routed',
        text: t(
          '已开启本地路由：上游格式「{0}」不是 {1} 的原生格式，经本机 {2} 转换后再转发',
          formatLabel(kind, active.apiFormat),
          NAME[kind],
          route?.listenUrl ?? '127.0.0.1',
        ),
      }
    : {
        mode: 'blocked',
        text: t(
          '需要本地路由但尚未开启：上游格式「{0}」不是 {1} 的原生格式（在「高级」里开启）',
          formatLabel(kind, active.apiFormat),
          NAME[kind],
        ),
      };
}

type View = { kind: 'list' } | { kind: 'add' } | { kind: 'edit'; target: CliEditorTarget };

export const CliEndpointSection: React.FC<{ kind: CliProviderKind }> = ({ kind }) => {
  const [state, setState] = useState<CliProviderState | null>(null);
  const [route, setRoute] = useState<CliRouteSettings | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [presets, setPresets] = useState<ProviderPreset[]>([CUSTOM_PRESET]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, CliProfileTestResult | 'pending'>>({});

  const refresh = useCallback(() => {
    void cliProviderClient
      .state()
      .then((s) => {
        setState(s);
        setRoute(s.routing);
      })
      .catch(() => setState(null));
  }, []);
  useEffect(() => {
    refresh();
    return cliProviderClient.onChanged((s) => {
      setState(s);
      setRoute(s.routing);
    });
  }, [refresh]);
  useEffect(() => {
    if (!providerClientAvailable()) return;
    void providerClient
      .presets()
      .then((ps) => setPresets(ps.some((p) => p.id === 'custom') ? ps : [CUSTOM_PRESET, ...ps]))
      .catch(() => undefined);
  }, []);

  const profiles = useMemo(
    () => (state?.profiles ?? []).filter((p) => p.kind === kind),
    [state, kind],
  );
  const active = profiles.find((p) => p.active) ?? null;
  const writes =
    kind === 'claude'
      ? state?.claudeSettings
      : kind === 'codex'
        ? state?.codexConfig
        : kind === 'grok'
          ? state?.grokConfig
          : state?.dshConfig;
  const store =
    kind === 'claude'
      ? state?.claudeStore
      : kind === 'codex'
        ? state?.codexStore
        : kind === 'grok'
          ? state?.grokStore
          : state?.dshStore;
  const rs = routingStatus(kind, active, route);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const activate = (p: CliProviderProfile) =>
    guard(async () => {
      const r = await cliProviderClient.activate(p.id);
      if (!r.ok) setMsg(r.error || t('启用失败'));
      else
        setMsg(
          r.usedRouting
            ? t('已启用（经本地路由）')
            : r.restartRequired
              ? t('已写入配置；Codex 可能需要重启会话')
              : t('已启用'),
        );
      refresh();
    });

  const deactivate = () =>
    guard(async () => {
      const r = await cliProviderClient.deactivate(kind);
      setMsg(r.ok ? t('已停用，{0} 回到自带登录/默认配置', NAME[kind]) : r.error || t('停用失败'));
      refresh();
    });

  const test = async (p: CliProviderProfile) => {
    setTests((c) => ({ ...c, [p.id]: 'pending' }));
    try {
      const r = await cliProviderClient.test(p.id);
      setTests((c) => ({ ...c, [p.id]: r }));
    } catch (e) {
      setTests((c) => ({
        ...c,
        [p.id]: { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  const patchRoute = (patch: Partial<CliRouteSettings>) =>
    guard(async () => setRoute(await cliRouteClient.set(patch)));

  const where =
    kind === 'claude'
      ? t(
          '启用档案时只改写 {0} 的 env（ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL），hooks、权限等其它设置原样保留，改写前自动备份。',
          writes ?? '~/.claude/settings.json',
        )
      : kind === 'codex'
        ? t(
            '启用档案时只改写 {0}（model、model_provider 与 [model_providers.nomi]）和同目录 auth.json 的 OPENAI_API_KEY，其它内容原样保留，改写前自动备份。',
            writes ?? '~/.codex/config.toml',
          )
        : kind === 'grok'
          ? t(
              '启用档案时只写入 {0} 里带 Nomi 标记的 [model.nomi] 区块并设置 default；密钥不落盘，只在 Nomi 启动 Grok 时通过环境变量注入。',
              writes ?? '~/.grok/config.toml',
            )
          : t(
              '启用档案时只写入 {0} 里带 Nomi 标记的区块；密钥不落盘，只在 Nomi 启动 dsh 时通过环境变量注入。',
              writes ?? '~/.dsh/cordis.patch.yml',
            );

  const activeBrand = (p: CliProviderProfile) =>
    p.presetId && p.presetId !== 'custom' ? p.presetId : inferBrand(p.baseUrl);

  return (
    <ToastProvider>
      <div className={styles.section} data-testid={`providers-section-${kind}`}>
        <div className={styles.intro} data-testid="cli-ep-intro">
          <p>
            <strong>{t(NAME[kind])}</strong>
            {t(' 的供应商档案独立保存，与 Nomi、其它编程助手互不影响。')}
          </p>
          <p>{where}</p>
        </div>

        <CliVersionCard kind={kind} />

        <section className={styles.card} data-testid={`cli-provider-list-${kind}`}>
          <div className={ppStyles.stack}>
            <div className={ppStyles.inline}>
              <span className="cd-muted" data-testid="cli-ep-status">
                {t('当前：')}
                <b data-testid="cli-ep-active">
                  {active ? active.name : t('使用 CLI 自带登录/默认配置')}
                </b>
                {active?.model && (
                  <>
                    {' '}
                    · <span>{active.model}</span>
                  </>
                )}
              </span>
              <span className="cd-spacer" />
              <Button
                variant="primary"
                data-testid="cli-add-provider"
                onClick={() => setView({ kind: 'add' })}
              >
                <Icon icon={Plus} size={14} />
                {t('添加供应商')}
              </Button>
            </div>
            <dl className={styles.facts}>
              <dt>{t('来源')}</dt>
              <dd data-testid="cli-ep-source">
                {active ? t('Nomi 档案库（独立）') : t('CLI 自带登录 / 默认配置')}
              </dd>
              <dt>{t('上游格式')}</dt>
              <dd>{active ? formatLabel(kind, active.apiFormat) : '—'}</dd>
              <dt>{t('本地路由')}</dt>
              <dd data-testid="cli-ep-routing" data-mode={rs.mode}>
                {rs.text}
              </dd>
            </dl>

            <Card
              active={!active}
              className={ppStyles.card}
              data-testid="cli-provider-default"
              title={
                <span className={ppStyles.inline}>
                  <EndpointIcon backend={kind} size={28} decorative />
                  <span>{t('CLI 自带登录 / 默认配置')}</span>
                  {!active && <Badge data-testid="cli-default-current">{t('当前')}</Badge>}
                </span>
              }
              subtitle={t(
                '不经过 Nomi：沿用 {0} 自己的登录或配置（默认）。启用下方任一供应商后会改用它。',
                NAME[kind],
              )}
              actions={
                active ? (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    data-testid="cli-ep-use-default"
                    onClick={() => void deactivate()}
                  >
                    {t('改用 CLI 自带登录/默认配置')}
                  </Button>
                ) : undefined
              }
            />

            {profiles.length === 0 && (
              <EmptyState
                icon={CloudCog}
                title={t('还没有第三方供应商')}
                description={t('点「添加供应商」，选择预设模板或自定义配置')}
              />
            )}
            {profiles.map((p) => {
              const tr = tests[p.id];
              return (
                <Card
                  key={p.id}
                  active={p.active}
                  className={ppStyles.card}
                  data-testid={`cli-provider-row-${p.id}`}
                  title={
                    <span className={ppStyles.inline}>
                      <Monogram name={p.name} brand={activeBrand(p)} size={28} />
                      <span>{p.name}</span>
                      {p.active && <Badge data-testid="cli-provider-active">{t('使用中')}</Badge>}
                      {p.needsRouting && (
                        <Badge tone="warning" data-testid="cli-provider-needs-routing">
                          {t('需路由')}
                        </Badge>
                      )}
                    </span>
                  }
                  subtitle={
                    <span>
                      {formatLabel(kind, p.apiFormat)} ·{' '}
                      <code className="cd-code">{p.baseUrl}</code>
                      {p.model ? ` · ${p.model}` : ''}
                    </span>
                  }
                  actions={
                    <>
                      {tr && (
                        <Badge
                          tone={tr === 'pending' ? 'neutral' : tr.ok ? 'success' : 'danger'}
                          data-testid="cli-provider-test-result"
                          role="status"
                        >
                          {tr === 'pending'
                            ? t('测速中…')
                            : tr.ok
                              ? `${tr.latencyMs} ms${tr.note ? ` · ${tr.note}` : ''}`
                              : t('失败：{0}', (tr.error ?? '').slice(0, 80))}
                        </Badge>
                      )}
                      {!p.active && (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy}
                          data-testid="cli-provider-enable"
                          onClick={() => void activate(p)}
                        >
                          {t('启用')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={tr === 'pending'}
                        data-testid="cli-provider-test"
                        onClick={() => void test(p)}
                      >
                        <Icon icon={Zap} size={14} />
                        {t('测速')}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy}
                        data-testid="cli-provider-edit"
                        onClick={() =>
                          setView({ kind: 'edit', target: { kind: 'edit', profile: p } })
                        }
                      >
                        {t('编辑')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        data-testid="cli-provider-delete"
                        onClick={() => {
                          if (!window.confirm(t('删除供应商「{0}」及其 Token？', p.name))) return;
                          void guard(async () => (await cliProviderClient.remove(p.id), refresh()));
                        }}
                      >
                        {t('删除')}
                      </Button>
                    </>
                  }
                >
                  <div className="cd-muted">{p.hasKey ? `Token ${p.keyHint}` : t('无 Token')}</div>
                </Card>
              );
            })}
          </div>
        </section>

        {(view.kind === 'add' || view.kind === 'edit') && (
          <ModalHostContext.Provider value={{ mode: 'drawer' }}>
            <Modal
              open
              onClose={() => setView({ kind: 'list' })}
              title={
                view.kind === 'add'
                  ? t('添加供应商')
                  : view.target.kind === 'edit'
                    ? t('编辑供应商')
                    : t('添加 {0}', view.target.preset.name)
              }
              size="lg"
              data-testid="cli-provider-drawer"
              bodyClassName={ppStyles.drawerBody}
            >
              {view.kind === 'add' && (
                <div className={ppStyles.stack}>
                  <AddProvider
                    presets={presets}
                    onPick={(preset) => setView({ kind: 'edit', target: { kind: 'new', preset } })}
                  />
                </div>
              )}
              {view.kind === 'edit' && (
                <CliProviderEditor
                  key={
                    view.target.kind === 'edit'
                      ? view.target.profile.id
                      : `new-${view.target.preset.id}`
                  }
                  endpoint={kind}
                  target={view.target}
                  onBack={() =>
                    setView(view.target.kind === 'new' ? { kind: 'add' } : { kind: 'list' })
                  }
                  onError={(e) => setMsg(e instanceof Error ? e.message : String(e))}
                  onSaved={(p, doActivate) => {
                    setView({ kind: 'list' });
                    setMsg(view.target.kind === 'edit' ? t('已更新档案') : t('已保存档案'));
                    refresh();
                    if (doActivate) void activate(p);
                  }}
                />
              )}
            </Modal>
          </ModalHostContext.Provider>
        )}

        <details className={styles.advanced} data-testid="cli-route-advanced">
          <summary>{t('高级')}</summary>
          <div className={styles.advBody}>
            {kind === 'dsh' || kind === 'grok' ? (
              <p className={styles.sub}>
                {kind === 'grok'
                  ? t(
                      'Grok 原生支持 responses / chat_completions / messages（api_backend），不需要本地路由。',
                    )
                  : t(
                      'dsh 原生支持 openai-completions / openai-responses / anthropic-messages，不需要本地路由。',
                    )}
              </p>
            ) : (
              <>
                <p className={styles.sub}>
                  {t('非原生上游格式时，CLI 仍发原生协议；由本机路由转换后再转发。')}
                </p>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={Boolean(route?.enabled)}
                    data-testid="cli-route-enabled"
                    onChange={(e) => void patchRoute({ enabled: e.target.checked })}
                  />
                  {t('开启本地路由')}
                </label>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={Boolean(route?.[kind])}
                    disabled={!route?.enabled}
                    data-testid={`cli-route-${kind}`}
                    onChange={(e) => void patchRoute({ [kind]: e.target.checked })}
                  />
                  {t('接管 {0}', NAME[kind])}
                </label>
                {route?.listenUrl && (
                  <span className={styles.sub} data-testid="cli-route-url">
                    {t('监听')} {route.listenUrl}
                  </span>
                )}
              </>
            )}
            <pre className={styles.paths} data-testid="cli-provider-paths">
              {[t('档案库：{0}', store ?? '-'), t('写入位置：{0}', writes ?? '-')].join('\n')}
            </pre>
          </div>
        </details>

        {msg && (
          <Notice tone="info" data-testid="cli-provider-msg">
            {msg}
          </Notice>
        )}
      </div>
    </ToastProvider>
  );
};
