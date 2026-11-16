import { t as tr } from '@nomi-ai/ui';

import type { HostDroppedFile } from '../../services/api';
import {
  MAX_FILE_ATTACHMENTS,
  fetchHostFile,
  fileAttachmentFrom,
  fileAttachmentFromHost,
  isImagePath,
  type FileAttachment,
} from '../../services/fileAttachments';
import {
  MAX_ATTACHMENTS,
  attachmentFromFile,
  type ImageAttachment,
} from '../../services/screenClient';

export async function processImageFiles(
  files: File[],
  onError: (msg: string) => void,
): Promise<ImageAttachment[]> {
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return [];

  const out: ImageAttachment[] = [];
  for (const f of imgs) {
    try {
      out.push(await attachmentFromFile(f));
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return out;
}

export async function processOtherFiles(
  files: File[],
  onError: (msg: string) => void,
): Promise<FileAttachment[]> {
  const out: FileAttachment[] = [];
  for (const f of files) {
    const a = await fileAttachmentFrom(f);
    if (a) out.push(a);
    else onError(tr('ui.knowledge-local.can-t-read-file', f.name));
  }
  return out;
}

export function addImagesToList(
  current: ImageAttachment[],
  incoming: ImageAttachment[],
  onError: (msg: string) => void,
): ImageAttachment[] {
  const next = [...current, ...incoming];
  if (next.length > MAX_ATTACHMENTS) {
    onError(tr('ui.knowledge-local.up-to-images', MAX_ATTACHMENTS));
  }
  return next.slice(0, MAX_ATTACHMENTS);
}

export function addFilesToList(
  current: FileAttachment[],
  incoming: FileAttachment[],
  onError: (msg: string) => void,
): FileAttachment[] {
  const next = [...current, ...incoming];
  if (next.length > MAX_FILE_ATTACHMENTS) {
    onError(tr('ui.knowledge-local.up-to-files', MAX_FILE_ATTACHMENTS));
  }
  return next.slice(0, MAX_FILE_ATTACHMENTS);
}

export async function processHostDroppedFiles(
  list: HostDroppedFile[],
  onError: (msg: string) => void,
): Promise<{ images: File[]; files: FileAttachment[] }> {
  const imgs = list.filter((f) => isImagePath(f.name) && f.url);
  const others = list.filter((f) => !imgs.includes(f));

  const imageFiles: File[] = [];
  if (imgs.length) {
    const read = await Promise.all(imgs.map(fetchHostFile));
    const ok = read.filter((f): f is File => !!f);
    for (const f of imgs.filter((_, i) => !read[i])) {
      onError(tr('ui.knowledge-local.can-t-read-file', f.name));
    }
    imageFiles.push(...ok);
  }

  const fileAttachments: FileAttachment[] = [];
  if (others.length) {
    fileAttachments.push(...(await Promise.all(others.map(fileAttachmentFromHost))));
  }

  return { images: imageFiles, files: fileAttachments };
}
