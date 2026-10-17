/**
 * CLI 端点的供应商表单：与 Nomi 的 ProviderEditor 同一套版式（名称 / API Key / 请求地址 / 模型 / 上游格式），
 * 保存时写入该端点自己的档案库。预设只是预填模板，所有字段都可改。
 */
import { Badge, Button, FormField, Input, Notice, Select, t, Icon } from '@nomi-ai/ui';
import { ChevronLeft, Lock } from 'lucide-react';
import React, { useState } from 'react';

import {
  cliProviderClient,
  type CliProviderKind,
  type CliProviderProfile,
} from '../../services/cliProviderClient';
import {
  LOCAL_ONLY_NOTICE,
  providerClient,
  providerClientAvailable,
  type FetchModelsResult,
  type FetchedModel,
  type ProviderPreset,
} from '../../services/providerClient';
import ppStyles from '../ProviderPanel/index.module.css';
import { Monogram, FetchBadge } from '../ProviderPanel/shared';

import { inferBrand, nativeFormat } from './cliBrand';

type Fmt = Parameters<typeof cliProviderClient.upsert>[0]['apiFormat'];

export const CLI_FORMATS: Record<CliProviderKind, Array<{ value: string; label: string }>> = {
  claude: [
    { value: 'anthropic_messages', label: 'Anthropic Messages（原生）' },
    { value: 'openai_chat_completions', label: 'OpenAI Chat Completions（需开启路由）' },
    { value: 'openai_responses', label: 'OpenAI Responses API（需开启路由）' },
    { value: 'gemini_generate_content', label: 'Gemini Native generateContent（需开启路由）' },
  ],
  codex: [
    { value: 'openai_responses', label: 'Responses（原生）' },
    { value: 'openai_chat_completions', label: 'Chat Completions（需开启路由）' },
    { value: 'anthropic_messages', label: 'Anthropic Messages（需开启路由）' },
  ],
  dsh: [
    { value: 'openai_responses', label: 'OpenAI Responses（原生）' },
    { value: 'openai_chat_completions', label: 'OpenAI Chat Completions（原生）' },
    { value: 'anthropic_messages', label: 'Anthropic Messages（原生）' },
  ],
  grok: [
    { value: 'openai_responses', label: 'OpenAI Responses（原生）' },
    { value: 'openai_chat_completions', label: 'OpenAI Chat Completions（原生）' },
    { value: 'anthropic_messages', label: 'Anthropic Messages（原生）' },
  ],
};
export const CLI_DEFAULT_FORMAT: Record<CliProviderKind, string> = {
  claude: 'anthropic_messages',
  codex: 'openai_responses',
  dsh: 'openai_responses',
  grok: 'openai_responses',
};

export type CliEditorTarget =
  { kind: 'new'; preset: ProviderPreset } | { kind: 'edit'; profile: CliProviderProfile };

export const CliProviderEditor: React.FC<{
  endpoint: CliProviderKind;
  target: CliEditorTarget;
  onBack: () => void;
  /** activate=true：保存后立刻启用 */
  onSaved: (profile: CliProviderProfile, activate: boolean) => void;
  onError: (e: unknown) => void;
}> = ({ endpoint, target, onBack, onSaved, onError }) => {
  const saved = target.kind === 'edit' ? target.profile : undefined;
  const preset = target.kind === 'new' ? target.preset : undefined;
  const presetId = saved?.presetId ?? preset?.id;
  const [name, setName] = useState(
    saved?.name ?? (preset && preset.id !== 'custom' ? preset.name : ''),
  );
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? preset?.baseURL ?? '');
  const [model, setModel] = useState(saved?.model ?? preset?.defaultModel ?? '');
  // 新建时默认用该 CLI 端点自己的原生格式，不被 Nomi 预设 protocol 改写（预设只预填 name/url/model/key）。
  const [apiFormat, setApiFormat] = useState<string>(
    saved?.apiFormat ?? CLI_DEFAULT_FORMAT[endpoint],
  );
  const [fetched, setFetched] = useState<FetchedModel[]>([]);
  const [fetchRes, setFetchRes] = useState<FetchModelsResult | 'pending'>();
  const [busy, setBusy] = useState(false);

  const fmtLabel = (v: string) => CLI_FORMATS[endpoint].find((f) => f.value === v)?.label ?? v;
  const needsRouting = !nativeFormat(endpoint, apiFormat);
  const keyRequired = target.kind === 'new' && Boolean(preset?.requiresApiKey);
  const missing = !baseUrl.trim() || (keyRequired && !apiKey.trim());
  const title = saved ? t('编辑 {0}', saved.name) : t('添加 {0}', preset!.name);

  const toProtocol = (f: string) =>
    f === 'anthropic_messages'
      ? 'anthropic'
      : f === 'openai_responses'
        ? 'openai-responses'
        : 'openai-chat';

  const fetchModels = async () => {
    if (!providerClientAvailable()) return;
    setFetchRes('pending');
    try {
      const r = await providerClient.fetchModelsDraft({
        name: name || 'draft',
        protocol: toProtocol(apiFormat) as never,
        baseURL: baseUrl,
        apiKey: apiKey.trim() || undefined,
      });
      setFetchRes(r);
      if (r.ok) setFetched(r.models);
    } catch (e) {
      setFetchRes(undefined);
      onError(e);
    }
  };

  const save = async (activate: boolean) => {
    setBusy(true);
    try {
      const p = await cliProviderClient.upsert({
        id: saved?.id,
        kind: endpoint,
        name: name.trim() || preset?.name || t('自定义'),
        baseUrl,
        model: model.trim(),
        apiFormat: apiFormat as Fmt,
        apiKey: apiKey.trim() || undefined,
        presetId,
      });
      setApiKey('');
      onSaved(p, activate);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={ppStyles.editor} data-testid="cli-provider-form" data-endpoint={endpoint}>
      <div className={ppStyles.editorHead}>
        <button
          type="button"
          className={ppStyles.back}
          onClick={onBack}
          aria-label={t('返回')}
          data-testid="cli-editor-back"
        >
          <Icon icon={ChevronLeft} size={18} />
        </button>
        <h3>{title}</h3>
        <span className="cd-muted">{t(fmtLabel(apiFormat))}</span>
      </div>

      <div className={ppStyles.editorBody}>
        {saved?.active && (
          <Notice data-testid="cli-active-edit-notice">
            {t('ⓘ 这是正在使用的供应商。保存后会立即重新写入该端点的配置。')}
          </Notice>
        )}
        <div className={ppStyles.form}>
          <FormField
            label={
              <>
                {t('名称')} <span className={ppStyles.req}>*</span>
              </>
            }
          >
            {({ id }) => (
              <div className={ppStyles.inline}>
                <Monogram
                  name={name || preset?.name || '?'}
                  brand={presetId && presetId !== 'custom' ? presetId : inferBrand(baseUrl)}
                  size={36}
                />
                <Input
                  id={id}
                  data-testid="cli-provider-name"
                  value={name}
                  placeholder={t('例如：我的网关')}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            )}
          </FormField>
          <FormField label={t('上游格式')}>
            <Select
              data-testid="cli-provider-format"
              value={apiFormat}
              onChange={(e) => setApiFormat(e.target.value)}
              menuMinWidth={320}
              options={CLI_FORMATS[endpoint].map((f) => ({ value: f.value, label: t(f.label) }))}
            />
          </FormField>

          <FormField
            label={<>API Key {keyRequired && <span className={ppStyles.req}>*</span>}</>}
            className={ppStyles.full}
            hint={
              <span data-testid="cli-local-only-notice">
                <Icon icon={Lock} size={12} /> {t(LOCAL_ONLY_NOTICE)}
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
              <Input
                id={id}
                data-testid="cli-provider-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={
                  saved?.hasKey
                    ? t('已保存 {0}（留空则不修改）', saved.keyHint)
                    : preset?.requiresApiKey
                      ? t('粘贴 Token')
                      : t('可留空（本地服务）')
                }
                onChange={(e) => setApiKey(e.target.value)}
              />
            )}
          </FormField>

          <FormField
            className={ppStyles.full}
            label={
              <>
                {t('API 请求地址')} <span className={ppStyles.req}>*</span>
              </>
            }
            hint={
              preset?.docsUrl ? (
                <span>
                  {t('官方 API 文档：')}
                  <span className="cd-code">{preset.docsUrl}</span>
                </span>
              ) : undefined
            }
          >
            <Input
              data-testid="cli-provider-baseurl"
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </FormField>

          <FormField
            className={ppStyles.full}
            label={t('模型')}
            hint={t(
              '{0} 启动时使用的模型；可从上游获取列表，也可手填 ID。',
              endpoint === 'claude'
                ? 'Claude Code'
                : endpoint === 'codex'
                  ? 'Codex'
                  : endpoint === 'grok'
                    ? 'Grok'
                    : 'dsh',
            )}
          >
            {({ id }) => (
              <div className={ppStyles.stack}>
                <div className={ppStyles.inline}>
                  <Input
                    id={id}
                    data-testid="cli-provider-model"
                    list="cli-models"
                    value={model}
                    placeholder={t('获取模型后选择，或手填 ID')}
                    onChange={(e) => setModel(e.target.value)}
                  />
                  <datalist id="cli-models">
                    {fetched.map((m) => (
                      <option key={m.id} value={m.id} />
                    ))}
                  </datalist>
                  {providerClientAvailable() && (
                    <Button
                      size="sm"
                      data-testid="cli-fetch-models"
                      title={t('从上游获取模型列表')}
                      disabled={!baseUrl.trim()}
                      onClick={() => void fetchModels()}
                    >
                      {t('⤓ 获取模型')}
                    </Button>
                  )}
                </div>
                <FetchBadge r={fetchRes} />
              </div>
            )}
          </FormField>

          {needsRouting && (
            <div className={ppStyles.full}>
              <Notice tone="warning" data-testid="cli-editor-routing-hint">
                <Badge tone="warning">{t('需路由')}</Badge>{' '}
                {t(
                  '「{0}」不是该端点的原生格式：CLI 仍发原生协议，由本机路由转换后再转发。启用前请先在页面底部的「高级」里开启本地路由。',
                  t(fmtLabel(apiFormat)).replace(/[（(].*[）)]/, ''),
                )}
              </Notice>
            </div>
          )}
        </div>
      </div>

      <div className={ppStyles.editorFoot}>
        <span className="cd-spacer" />
        <Button onClick={onBack}>{t('取消')}</Button>
        {!saved && (
          <Button
            data-testid="cli-provider-save"
            disabled={busy || missing}
            onClick={() => void save(false)}
          >
            {t('保存')}
          </Button>
        )}
        <Button
          variant="primary"
          data-testid={saved ? 'cli-provider-save' : 'cli-provider-save-activate'}
          disabled={busy || missing}
          onClick={() => void save(!saved)}
        >
          {saved ? t('保存') : t('保存并设为当前')}
        </Button>
      </div>
    </div>
  );
};
