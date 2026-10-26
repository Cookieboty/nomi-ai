/**
 * 生图 IPC（ai:media:*）。Key 只进不出：渲染层只能写入 / 清除，读取永远拿不到明文。
 */
import * as fs from 'fs';
import * as path from 'path';

import { ASSET_SOURCES, type AssetSource, type MediaModelChoice } from '@nomi-ai/gateway/media';
import { BrowserWindow, ClipboardItem, clipboard, dialog, nativeImage } from 'electron';

import { guardedHandle } from '../security/guardedIpc';

import type { MediaService } from './MediaService';

let done = false;

const str = (v: unknown, max = 4096): string => (typeof v === 'string' ? v.slice(0, max) : '');
const choiceOf = (v: unknown): MediaModelChoice | null => {
  const o = v as Partial<MediaModelChoice> | null;
  return o && typeof o.modelId === 'string' && typeof o.providerRef === 'string'
    ? { modelId: o.modelId, providerRef: o.providerRef }
    : null;
};
const sourceOf = (v: unknown, fallback: AssetSource): AssetSource =>
  ASSET_SOURCES.includes(v as AssetSource) ? (v as AssetSource) : fallback;
const MAX_SRC = 40 * 1024 * 1024;

export function broadcastMedia(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

export function registerMediaIpc(svc: MediaService): void {
  if (done) return;
  done = true;
  const handle = (ch: string, fn: (...a: unknown[]) => unknown) =>
    guardedHandle(
      ch,
      async (...a: unknown[]) => {
        try {
          return await fn(...a);
        } catch (err) {
          const p = (svc.constructor as typeof MediaService).errorPayload(err);
          if (p) return p;
          throw err;
        }
      },
      { owner: 'MediaService', wrapErrors: false },
    );

  handle('ai:media:state', () => svc.state());
  handle('ai:media:upsert-provider', (p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return svc.upsertProvider({
      ...(typeof o.id === 'string' ? { id: o.id } : {}),
      ...(typeof o.name === 'string' ? { name: str(o.name, 80) } : {}),
      ...(typeof o.baseURL === 'string' ? { baseURL: str(o.baseURL, 500) } : {}),
      ...(typeof o.enabled === 'boolean' ? { enabled: o.enabled } : {}),
      ...(o.apiKey === null || typeof o.apiKey === 'string'
        ? { apiKey: o.apiKey === null ? null : str(o.apiKey, 1000) }
        : {}),
    });
  });
  handle('ai:media:remove-provider', (id) => svc.removeProvider(str(id, 64)));
  handle('ai:media:upsert-binding', (p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const c = choiceOf(o);
    if (!c) return { __error: { code: 'invalid', message: 'invalid binding' } };
    return svc.upsertBinding({
      ...c,
      ...(typeof o.enabled === 'boolean' ? { enabled: o.enabled } : {}),
      ...(typeof o.presetKey === 'string' ? { presetKey: o.presetKey as never } : {}),
      ...(typeof o.upstreamModelName === 'string'
        ? { upstreamModelName: str(o.upstreamModelName, 200) }
        : {}),
    });
  });
  handle('ai:media:remove-binding', (p) => {
    const c = choiceOf(p);
    return c ? svc.removeBinding(c) : { changes: [] };
  });
  handle('ai:media:set-chat-default', (p) => svc.setChatDefault(choiceOf(p)));
  handle('ai:media:set-prefs', (p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return svc.setPrefs({
      ...(typeof o.autoAddGenerated === 'boolean' ? { autoAddGenerated: o.autoAddGenerated } : {}),
      ...(typeof o.autoAddUploads === 'boolean' ? { autoAddUploads: o.autoAddUploads } : {}),
    });
  });
  handle('ai:media:start', (p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const c = choiceOf(o);
    if (!c) return { __error: { code: 'not_configured', message: 'no model selected' } };
    const refs: Array<{ assetId: string } | { mime: string; data: string }> = [];
    for (const raw of Array.isArray(o.refs) ? (o.refs as unknown[]).slice(0, 8) : []) {
      const r = (raw ?? {}) as { assetId?: unknown; mime?: unknown; data?: unknown };
      if (typeof r.assetId === 'string') refs.push({ assetId: r.assetId });
      else if (typeof r.mime === 'string' && typeof r.data === 'string')
        refs.push({ mime: r.mime, data: r.data });
    }
    return svc.start({
      ...c,
      prompt: str(o.prompt, 4000),
      params: (o.params && typeof o.params === 'object' ? o.params : {}) as never,
      surface: 'studio',
      ...(refs.length ? { refs } : {}),
    });
  });
  handle('ai:media:tasks', () => svc.listTasks());
  handle('ai:media:assets', (p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return svc.listAssets(
      ASSET_SOURCES.includes(o.source as AssetSource) ? { source: o.source as AssetSource } : {},
    );
  });
  handle('ai:media:lookup', (src) => svc.lookup(str(src, MAX_SRC)));
  handle('ai:media:add-asset', (src, source, conv) =>
    svc.addFromSrc(str(src, MAX_SRC), sourceOf(source, 'manual_add'), str(conv, 128) || undefined),
  );
  handle('ai:media:set-in-library', (id, v) => svc.setInLibrary(str(id, 64), v === true));
  handle('ai:media:ingest-uploads', (imgs, conv) =>
    svc.ingestUploads(
      Array.isArray(imgs)
        ? (imgs as Array<{ mime?: unknown; data?: unknown }>)
            .filter((i) => typeof i?.mime === 'string' && typeof i?.data === 'string')
            .map((i) => ({ mime: i.mime as string, data: i.data as string }))
        : [],
      str(conv, 128) || undefined,
    ),
  );
  handle('ai:media:copy-image', async (src) => {
    const got = await svc.readSrc(str(src, MAX_SRC));
    if (!got) return false;
    const png = nativeImage.createFromBuffer(got.data).toPNG();
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) }),
    ]);
    return true;
  });
  handle('ai:media:save-image', async (src, name) => {
    const got = await svc.readSrc(str(src, MAX_SRC));
    if (!got) return false;
    const ext = got.mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const base = (str(name, 80) || `nomi-image-${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
    const r = await dialog.showSaveDialog({ defaultPath: `${base}.${ext}` });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, got.data);
    return true;
  });
  handle('ai:media:import', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths.slice(0, 50)) {
      const data = fs.readFileSync(f);
      const ext = path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg');
      out.push(
        await svc.addFromSrc(`data:image/${ext};base64,${data.toString('base64')}`, 'manual_add'),
      );
    }
    return out;
  });
}
