/**
 * 新建 / 编辑供应商（新建 / 编辑供应商）：
 *   名称* + 备注 · 官网链接 · API Key*（本地加密） · API 请求地址*（完整 URL 开关 / 管理与测速）
 *   · 默认模型（获取模型列表 → 勾选启用）· 高级选项（上游格式 / 模型映射 / 思考 / UA / Headers）
 * 编辑正在使用的供应商时提示「保存后立即生效」。
 */
import { t, Icon } from '@nomi-ai/ui';
import {
  Badge,
  Button,
  FormField,
  Input,
  Notice,
  Select,
  Switch,
  Textarea,
  SkeletonList,
  useToast,
} from '@nomi-ai/ui';
import {
  ChevronLeft,
  Eye,
  EyeOff,
  Link,
  Lock,
  Plus,
  X,
  Zap,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';

import {
  LOCAL_ONLY_NOTICE,
  PROTOCOL_LABELS,
  endpointPreview,
  providerClient,
  type FetchModelsResult,
  type FetchedModel,
  type ModelMapping,
  type Protocol,
  type ProviderInput,
  type ProviderPreset,
  type ProviderView,
  type TestResult,
} from '../../services/providerClient';

import styles from './index.module.css';
import { KeyManager } from './KeyManager';
import { FetchBadge, Monogram, TestBadge, headersToText, parseHeaders } from './shared';

export type EditorTarget =
  { kind: 'new'; preset: ProviderPreset } | { kind: 'edit'; provider: ProviderView };

const PROTOCOL_HINT: Record<Protocol, string> = {
  'openai-chat': '填写兼容 OpenAI Chat Completions 的服务端点地址（会拼接 /chat/completions）',
  'openai-responses': '填写兼容 OpenAI Responses 格式的服务端点地址（会拼接 /responses）',
  anthropic: '填写兼容 Anthropic Messages 的服务端点地址（会拼接 /v1/messages）',
};

export type SaveResult = {
  provider: ProviderView;
  /** 保存后已拉取模型列表，请留在编辑器里选默认模型 */
  pickModel: boolean;
};

export const ProviderEditor: React.FC<{
  target: EditorTarget;
  isActive: boolean;
  onBack: () => void;
  onSaved: (result: SaveResult) => void;
  onError: (e: unknown) => void;
}> = ({ target, isActive, onBack, onSaved, onError }) => {
  const toast = useToast();
  const modelListAnchorRef = useRef<HTMLDivElement>(null);
  const saved = target.kind === 'edit' ? target.provider : undefined;
  const preset = target.kind === 'new' ? target.preset : undefined;
  const [name, setName] = useState(
    saved?.name ?? (preset?.id === 'custom' ? '' : (preset?.name ?? '')),
  );
  const [note, setNote] = useState(saved?.note ?? '');
  const [websiteUrl, setWebsiteUrl] = useState(saved?.websiteUrl ?? preset?.websiteUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [baseURL, setBaseURL] = useState(saved?.baseURL ?? preset?.baseURL ?? '');
  const [fullUrl, setFullUrl] = useState(saved?.fullUrl ?? false);
  const [protocol, setProtocol] = useState<Protocol>(
    saved?.protocol ?? preset?.protocol ?? 'openai-chat',
  );
  const [defaultModel, setDefaultModel] = useState(
    saved?.defaultModel ?? preset?.defaultModel ?? '',
  );
  const [fetched, setFetched] = useState<FetchedModel[]>(
    saved?.fetchedModels ?? (preset?.models ?? []).map((id) => ({ id })),
  );
  const [enabled, setEnabled] = useState<Set<string>>(
    new Set(saved?.models ?? (preset?.defaultModel ? [preset.defaultModel] : [])),
  );
  const [modelFilter, setModelFilter] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [modelMap, setModelMap] = useState<ModelMapping[]>(saved?.modelMap ?? []);
  const [thinking, setThinking] = useState(Boolean(saved?.thinking));
  const [userAgent, setUserAgent] = useState(saved?.userAgent ?? '');
  const [headersText, setHeadersText] = useState(headersToText(saved?.headers));
  const [test, setTest] = useState<TestResult | 'pending'>();
  const [fetchRes, setFetchRes] = useState<FetchModelsResult | 'pending'>();
  const [busy, setBusy] = useState(false);

  const endpoint = endpointPreview(protocol, baseURL, fullUrl);
  const keyRequired = target.kind === 'new' && Boolean(preset?.requiresApiKey);
  const title = target.kind === 'edit' ? t('编辑 {0}', saved!.name) : t('添加 {0}', preset!.name);

  const input = (): ProviderInput => ({
    ...(saved ? { id: saved.id } : { presetId: preset!.id }),
    name: name.trim() || preset?.name || t('自定义'),
    note,
    websiteUrl,
    protocol,
    baseURL,
    fullUrl,
    defaultModel: defaultModel.trim(),
    models: [...enabled],
    fetchedModels: fetched,
    modelMap: modelMap.filter((m) => m.from.trim() && m.to.trim()),
    thinking,
    userAgent,
    headers: parseHeaders(headersText),
    apiKey: apiKey.trim() || undefined,
  });

  const needModel = !defaultModel.trim();
  // 允许先保存再拉模型；默认模型在保存后的列表里选择
  const missing = !baseURL.trim() || (keyRequired && !apiKey.trim());

  const applyFetchResult = (r: FetchModelsResult) => {
    setFetchRes(r);
    if (r.ok) {
      setFetched(r.models);
      // 不自动设默认：留给用户点「设为默认」
      modelListAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const save = async (activate: boolean) => {
    setBusy(true);
    try {
      let view = await providerClient.upsert(input());
      if (activate) await providerClient.setActive(view.id);
      setApiKey('');

      const hasKey = view.keys.length > 0;
      const canFetch = !!view.baseURL.trim() && (!keyRequired || hasKey);
      if (canFetch) {
        setFetchRes('pending');
        // 刷新列表时保留已有勾选，避免闪空；首次则显示骨架
        if (fetched.length === 0) setFetched([]);
        try {
          const r = await providerClient.fetchModels(view.id);
          applyFetchResult(r);
          const st = await providerClient.state();
          view = st.providers.find((p) => p.id === view.id) ?? view;
          const stay = !view.defaultModel.trim();
          if (r.ok) {
            toast.show(
              stay
                ? r.models.length
                  ? t('已获取 {0} 个模型，请选择默认模型', r.models.length)
                  : t('模型列表为空，请手填模型 ID')
                : t('已刷新模型列表（{0}）', r.models.length),
              { tone: r.models.length || !stay ? 'success' : 'warning' },
            );
          } else {
            toast.show(r.error || t('获取模型失败'), { tone: 'danger' });
          }
          onSaved({ provider: view, pickModel: stay });
        } catch (e) {
          setFetchRes(undefined);
          toast.show(e instanceof Error ? e.message : t('获取模型失败'), { tone: 'danger' });
          onSaved({ provider: view, pickModel: !view.defaultModel.trim() });
        }
      } else {
        onSaved({ provider: view, pickModel: false });
      }
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const fetchModels = async () => {
    setFetchRes('pending');
    try {
      const r = await providerClient.fetchModelsDraft(input());
      applyFetchResult(r);
      if (r.ok) {
        toast.show(r.models.length ? t('已获取 {0} 个模型', r.models.length) : t('模型列表为空'), {
          tone: r.models.length ? 'success' : 'warning',
        });
      } else {
        toast.show(r.error || t('获取模型失败'), { tone: 'danger' });
      }
    } catch (e) {
      setFetchRes(undefined);
      toast.show(e instanceof Error ? e.message : t('获取模型失败'), { tone: 'danger' });
      onError(e);
    }
  };

  const toggle = (id: string) =>
    setEnabled((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const visible = useMemo(
    () =>
      fetched.filter((m) => !modelFilter || m.id.toLowerCase().includes(modelFilter.toLowerCase())),
    [fetched, modelFilter],
  );

  return (
    <div className={styles.editor} data-testid="provider-editor">
      <div className={styles.editorHead}>
        <button
          type="button"
          className={styles.back}
          onClick={onBack}
          aria-label={t('返回')}
          data-testid="editor-back"
        >
          <Icon icon={ChevronLeft} size={18} />
        </button>
        <h3>{title}</h3>
        <span className="cd-muted">{t(PROTOCOL_LABELS[protocol])}</span>
      </div>

      <div className={styles.editorBody}>
        {isActive && (
          <Notice data-testid="active-edit-notice">
            {t('ⓘ 这是正在使用的供应商。保存后立即生效，下一次请求就用新的设置。')}
          </Notice>
        )}

        <div className={styles.form}>
          <FormField
            label={
              <>
                {t('名称')} <span className={styles.req}>*</span>
              </>
            }
          >
            {({ id }) => (
              <div className={styles.inline}>
                <Monogram name={name || preset?.name || '?'} brand={preset?.id} size={36} />
                <Input
                  id={id}
                  data-testid="draft-name"
                  value={name}
                  placeholder={t('例如：我的网关')}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            )}
          </FormField>
          <FormField label={t('备注')}>
            <Input
              data-testid="draft-note"
              value={note}
              placeholder={t('可选')}
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
          <FormField
            label={t('官网链接')}
            className={styles.full}
            hint={
              preset?.docsUrl ? (
                <span data-testid="preset-docs">
                  {t('官方 API 文档：')}
                  <span className="cd-code">{preset.docsUrl}</span>
                  {preset.verified &&
                    t(' · 预设已按文档核对（{0}）', preset.checkedAt ?? '2026-10-11')}
                </span>
              ) : undefined
            }
          >
            <Input
              data-testid="draft-website"
              value={websiteUrl}
              placeholder="https://"
              onChange={(e) => setWebsiteUrl(e.target.value)}
            />
          </FormField>

          <FormField
            label={<>API Key {keyRequired && <span className={styles.req}>*</span>}</>}
            className={styles.full}
            hint={
              <span data-testid="local-only-notice">
                <Icon icon={Lock} size={12} /> {LOCAL_ONLY_NOTICE}
                {preset?.apiKeyUrl && (
                  <>
                    {' '}
                    {t('· 获取：')}
                    <span className="cd-code">{preset.apiKeyUrl}</span>
                  </>
                )}
              </span>
            }
          >
            {({ id }) => (
              <div className={styles.inline}>
                <Input
                  id={id}
                  data-testid="draft-key"
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  value={apiKey}
                  placeholder={
                    saved?.keys[0]
                      ? t('已保存 {0}（留空则不修改；填写将设为主 Token）', saved.keys[0].masked)
                      : preset?.requiresApiKey
                        ? t('粘贴 Token')
                        : t('可留空（本地服务）')
                  }
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowKey(!showKey)}
                  aria-label={t('显示 / 隐藏')}
                >
                  <Icon icon={showKey ? EyeOff : Eye} />
                </Button>
              </div>
            )}
          </FormField>

          <FormField
            className={styles.full}
            label={
              <span className={styles.labelRow}>
                <span>
                  {t('API 请求地址')} <span className={styles.req}>*</span>
                </span>
                <span className={styles.pill}>
                  <Icon icon={Link} size={14} />
                  {t('完整 URL')}
                  <Switch
                    data-testid="draft-fullurl"
                    checked={fullUrl}
                    onChange={setFullUrl}
                    aria-label={t('完整 URL')}
                  />
                </span>
                <span className="cd-spacer" />
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="draft-test"
                  onClick={() => {
                    setTest('pending');
                    providerClient
                      .testDraft(input())
                      .then(setTest)
                      .catch((e) => {
                        setTest(undefined);
                        onError(e);
                      });
                  }}
                >
                  <Icon icon={Zap} size={14} />
                  {t('管理与测速')}
                </Button>
                <TestBadge r={test} />
              </span>
            }
            hint={
              <>
                {fullUrl ? t('完整 URL：按原样请求，不再拼接路径') : PROTOCOL_HINT[protocol]}
                {endpoint && (
                  <div>
                    {t('实际请求：')}
                    <code className="cd-code" data-testid="endpoint-preview">
                      POST {endpoint}
                    </code>
                  </div>
                )}
              </>
            }
          >
            <Input
              data-testid="draft-baseurl"
              value={baseURL}
              placeholder="https://api.example.com/v1"
              onChange={(e) => setBaseURL(e.target.value)}
            />
          </FormField>

          <FormField
            className={styles.full}
            label={
              <>
                {t('默认模型')} <span className={styles.req}>*</span>
              </>
            }
            hint={
              needModel
                ? t(
                    '预设不预填默认模型。可先保存（将自动获取模型列表），再点「设为默认」；也可手填模型 ID。',
                  )
                : t('对话默认请求的模型，随时可改；聊天窗口的模型选择器列出下方勾选的模型。')
            }
          >
            {({ id }) => (
              <div className={styles.stack}>
                {needModel && (
                  <Notice tone="warning" data-testid="fetch-models-prompt">
                    {t(
                      '尚未选择默认模型。保存后会自动获取模型列表，请在下方点「设为默认」；也可先点「获取模型」。',
                    )}
                  </Notice>
                )}
                <div className={styles.inline}>
                  <Input
                    id={id}
                    data-testid="draft-model"
                    list="pp-models"
                    value={defaultModel}
                    placeholder={t('获取模型后选择，或手填 ID')}
                    onChange={(e) => setDefaultModel(e.target.value)}
                  />
                  <datalist id="pp-models">
                    {fetched.map((m) => (
                      <option key={m.id} value={m.id} />
                    ))}
                  </datalist>
                  <Button
                    size="sm"
                    data-testid="fetch-models"
                    title={t('从上游获取模型列表')}
                    onClick={() => void fetchModels()}
                  >
                    {t('⤓ 获取模型')}
                  </Button>
                </div>
              </div>
            )}
          </FormField>

          <div className={styles.full} ref={modelListAnchorRef} data-testid="model-picker">
            <div className={styles.inline}>
              <FetchBadge r={fetchRes} />
              {fetched.length > 0 && (
                <>
                  <span className="cd-muted">
                    {t('已启用')} {enabled.size} / {fetched.length}
                  </span>
                  <span className="cd-spacer" />
                  <Input
                    size="sm"
                    placeholder={t('筛选模型')}
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                    style={{ maxWidth: 180 }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEnabled(new Set(fetched.map((m) => m.id)))}
                  >
                    {t('全选')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEnabled(new Set(defaultModel ? [defaultModel] : []))}
                  >
                    {t('清空')}
                  </Button>
                </>
              )}
            </div>
            {fetchRes === 'pending' && fetched.length === 0 && (
              <SkeletonList rows={4} className={styles.modelSkeleton} />
            )}
            {fetched.length > 0 && (
              <div className={styles.modelList} data-testid="model-list">
                {visible.map((m) => (
                  <label key={m.id} className={styles.modelRow} data-testid={`model-row-${m.id}`}>
                    <input
                      type="checkbox"
                      checked={enabled.has(m.id)}
                      onChange={() => toggle(m.id)}
                    />
                    <span className={styles.modelId}>{m.id}</span>
                    {m.name && <span className="cd-muted">{t(m.name)}</span>}
                    <span className="cd-spacer" />
                    {defaultModel === m.id ? (
                      <Badge>{t('默认')}</Badge>
                    ) : (
                      <button
                        type="button"
                        className={styles.linkBtn}
                        data-testid={`model-default-${m.id}`}
                        onClick={() => {
                          setDefaultModel(m.id);
                          setEnabled((s) => new Set(s).add(m.id));
                        }}
                      >
                        {t('设为默认')}
                      </button>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className={`${styles.full} ${styles.advanced}`}>
            <button
              type="button"
              className={styles.advHead}
              data-testid="advanced-toggle"
              onClick={() => setAdvanced(!advanced)}
              aria-expanded={advanced}
            >
              <span>
                <Icon icon={advanced ? ChevronDown : ChevronRight} size={14} /> {t('高级选项')}
              </span>
              <span className="cd-muted">
                {t('包含上游格式、模型映射、思考能力、自定义 User-Agent 与 Headers。')}
              </span>
            </button>
            {advanced && (
              <div className={styles.form}>
                <FormField label={t('上游格式')} className={styles.full}>
                  <Select
                    data-testid="draft-protocol"
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value as Protocol)}
                    options={(Object.keys(PROTOCOL_LABELS) as Protocol[]).map((p) => ({
                      value: p,
                      label: t(PROTOCOL_LABELS[p]),
                    }))}
                  />
                </FormField>
                <FormField
                  label={t('模型映射（请求模型 → 上游模型，* 匹配任意）')}
                  className={styles.full}
                >
                  {() => (
                    <div className={styles.mapList} data-testid="model-map">
                      {modelMap.map((m, i) => (
                        <div key={i} className={styles.inline}>
                          <Input
                            size="sm"
                            placeholder={t('请求模型')}
                            value={m.from}
                            onChange={(e) =>
                              setModelMap(
                                modelMap.map((x, j) =>
                                  j === i ? { ...x, from: e.target.value } : x,
                                ),
                              )
                            }
                          />
                          <span>→</span>
                          <Input
                            size="sm"
                            placeholder={t('上游模型')}
                            list="pp-models"
                            value={m.to}
                            onChange={(e) =>
                              setModelMap(
                                modelMap.map((x, j) =>
                                  j === i ? { ...x, to: e.target.value } : x,
                                ),
                              )
                            }
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('删除映射')}
                            onClick={() => setModelMap(modelMap.filter((_, j) => j !== i))}
                          >
                            <Icon icon={X} />
                          </Button>
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="map-add"
                        onClick={() => setModelMap([...modelMap, { from: '', to: '' }])}
                      >
                        <Icon icon={Plus} size={14} />
                        {t('添加映射')}
                      </Button>
                    </div>
                  )}
                </FormField>
                <FormField
                  label={t('思考 / 推理')}
                  hint="Anthropic：extended thinking；OpenAI：reasoning effort = medium"
                >
                  {() => (
                    <Switch
                      data-testid="draft-thinking"
                      checked={thinking}
                      onChange={setThinking}
                      label={thinking ? t('已开启') : t('已关闭')}
                    />
                  )}
                </FormField>
                <FormField label={t('User-Agent（可选）')}>
                  <Input
                    data-testid="draft-ua"
                    value={userAgent}
                    placeholder={t('默认')}
                    onChange={(e) => setUserAgent(e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('自定义 Headers（每行 Name: value 或 JSON）')}
                  className={styles.full}
                >
                  <Textarea
                    data-testid="draft-headers"
                    rows={2}
                    value={headersText}
                    onChange={(e) => setHeadersText(e.target.value)}
                  />
                </FormField>
                {saved && (
                  <div className={styles.full}>
                    <h4 className={styles.catTitle}>{t('Token 管理（多 Token 自动故障切换）')}</h4>
                    <KeyManager p={saved} onError={onError} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.editorFoot}>
        {needModel && (
          <span className="cd-muted" data-testid="save-then-pick-hint">
            {t('保存后将自动获取模型并打开列表供选择')}
          </span>
        )}
        <span className="cd-spacer" />
        <Button onClick={onBack}>{t('取消')}</Button>
        {target.kind === 'new' && (
          <Button
            data-testid="draft-save"
            disabled={busy || missing}
            onClick={() => void save(false)}
          >
            {t('保存')}
          </Button>
        )}
        <Button
          variant="primary"
          data-testid={target.kind === 'new' ? 'draft-save-activate' : 'draft-save'}
          disabled={busy || missing}
          onClick={() => void save(target.kind === 'new')}
        >
          {target.kind === 'new' ? t('保存并设为当前') : t('保存')}
        </Button>
      </div>
    </div>
  );
};
