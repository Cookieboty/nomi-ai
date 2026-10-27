/**
 * 对话里 generate_image 工具调用的结果卡：生成中 / 图片 / 未配置引导 / 失败（去配置、到工作台换模型重试）。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { ImageOff, Loader2, Settings2 } from 'lucide-react';
import React, { memo } from 'react';

import { modelName, openMedia, providerName, useMediaState } from '../../services/mediaClient';
import type { ToolCall } from '../../utils/toolTrace';

import styles from './Media.module.css';
import { MediaImageMenu } from './MediaImageMenu';

interface ParsedOk {
  ok: true;
  images: Array<{ id: string; url: string }>;
  modelId?: string;
  providerRef?: string;
}
interface ParsedErr {
  ok: false;
  code: string;
  message: string;
}

function tryJson(s: string | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(s.slice(i, j + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** 兼容 {ok,data} / {ok,error} 两种包装以及直接是 data 的情况 */
export function parseImageGenOutput(output: string | undefined): ParsedOk | ParsedErr | null {
  const v = tryJson(output) as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object') return null;
  const err = (v.error ?? null) as { code?: string; message?: string } | null;
  if (err && typeof err === 'object')
    return { ok: false, code: err.code ?? 'failed', message: err.message ?? '' };
  const data = (v.data && typeof v.data === 'object' ? v.data : v) as Record<string, unknown>;
  const images = Array.isArray(data.images)
    ? (data.images as Array<{ id?: unknown; url?: unknown }>)
        .filter((x) => typeof x?.url === 'string')
        .map((x) => ({ id: String(x.id ?? x.url), url: String(x.url) }))
    : [];
  if (!images.length) return null;
  return {
    ok: true,
    images,
    ...(typeof data.modelId === 'string' ? { modelId: data.modelId } : {}),
    ...(typeof data.providerRef === 'string' ? { providerRef: data.providerRef } : {}),
  };
}

function promptOf(call: ToolCall): string {
  const v = tryJson(call.input) as { prompt?: unknown } | undefined;
  return typeof v?.prompt === 'string' ? v.prompt : '';
}

export const ImageGenCard: React.FC<{ call: ToolCall; conversationId?: string }> = memo(
  ({ call, conversationId }) => {
    const [state] = useMediaState();
    const prompt = promptOf(call);
    const parsed = call.status === 'running' ? null : parseImageGenOutput(call.output);

    if (call.status === 'running')
      return (
        <div className={styles.card} data-testid="image-gen-card" data-state="running">
          <div className={styles.cardHead}>
            <Icon icon={Loader2} size={14} className={styles.spin} />
            <span>{t('ui.media.generating')}</span>
          </div>
          {prompt && <div className={styles.prompt}>{prompt}</div>}
          <div className={styles.placeholder} />
        </div>
      );

    if (parsed?.ok)
      return (
        <div className={styles.card} data-testid="image-gen-card" data-state="done">
          {prompt && <div className={styles.prompt}>{prompt}</div>}
          <div className={styles.grid}>
            {parsed.images.map((img) => (
              <MediaImageMenu
                key={img.id}
                src={img.url}
                source="chat_generated"
                conversationId={conversationId}
              >
                <img src={img.url} alt={prompt} className={styles.genImg} loading="lazy" />
              </MediaImageMenu>
            ))}
          </div>
          {parsed.modelId && (
            <div className={styles.meta}>
              {modelName(state, parsed.modelId)}
              {parsed.providerRef ? ` · ${providerName(state, parsed.providerRef)}` : ''}
            </div>
          )}
        </div>
      );

    const notConfigured = parsed && !parsed.ok && parsed.code === 'not_configured';
    return (
      <div
        className={`${styles.card} ${styles.guide}`}
        data-testid="image-gen-card"
        data-state={notConfigured ? 'not-configured' : 'error'}
      >
        <div className={styles.cardHead}>
          <Icon icon={notConfigured ? Settings2 : ImageOff} size={14} />
          <span>{notConfigured ? t('ui.media.guide-title') : t('ui.media.failed-title')}</span>
        </div>
        <div className={styles.guideText}>
          {notConfigured
            ? t('ui.media.guide-body')
            : (parsed && !parsed.ok && parsed.message) || t('ui.media.action-failed')}
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="primary" onClick={() => openMedia({ target: 'settings' })}>
            {t('ui.media.go-configure')}
          </Button>
          {!notConfigured && (
            <Button size="sm" onClick={() => openMedia({ target: 'studio', prompt })}>
              {t('ui.media.retry-in-studio')}
            </Button>
          )}
        </div>
      </div>
    );
  },
);
ImageGenCard.displayName = 'ImageGenCard';
