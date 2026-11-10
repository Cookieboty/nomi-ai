import { t } from '@nomi-ai/ui';

import { confirmDialog } from '../components/ConfirmDialog';
import type { ResourceImageInfo } from '../contexts/ResourceContext';
import { resourceTarget } from '../utils/resourceLinks';

import { resourcePreviewClient, type PreviewResult } from './resourcePreviewClient';

/** Documents with native viewers and ordinary web links open outside the chat. */
export function isExternalResource(href: string, image?: ResourceImageInfo): boolean {
  const target = resourceTarget(href);
  return (
    !!target &&
    (target.web
      ? image?.kind !== 'image'
      : /\.(?:html?|docx|xlsx|csv|pptx|pdf|mp4|webm|mov|m4v|ogv|mp3|wav|m4a|ogg|flac|aac)$/i.test(
          target.path ?? '',
        ))
  );
}
export async function openExternalResource(cwd: string, href: string): Promise<PreviewResult> {
  const target = resourceTarget(href);
  if (!target) return { ok: false, code: 'invalid' };
  const path = target.path ?? href;
  let result = await resourcePreviewClient.external(cwd, path);
  if (result.code === 'authorization') {
    const approved = await confirmDialog({
      title: t('ui.session-workspace.preview-authorize-title'),
      message: t('ui.session-workspace.preview-authorize-message', result.path ?? path),
      confirmLabel: t('ui.session-workspace.preview-authorize-file'),
    });
    if (!approved) return { ok: false, code: 'cancelled' };
    result = await resourcePreviewClient.external(cwd, path, true);
  }
  return result;
}
