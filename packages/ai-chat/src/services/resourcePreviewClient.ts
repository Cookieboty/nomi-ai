import { api, hasTransport } from './api';
export interface PreviewResult {
  ok: boolean;
  code?: string;
  path?: string;
  kind?: string;
  mime?: string;
  url?: string;
  content?: string;
  truncated?: boolean;
  editable?: boolean;
  revision?: string;
}
export interface PreviewSaveResult {
  ok: boolean;
  code?: string;
  revision?: string;
}
export interface PreviewDirectoryEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
}
export interface PreviewDirectoryResult {
  ok: boolean;
  code?: string;
  entries?: PreviewDirectoryEntry[];
  truncated?: boolean;
}
export const resourcePreviewClient = {
  listDirectory: async (url: string, path: string): Promise<PreviewDirectoryResult> => {
    if (!hasTransport()) return { ok: false, code: 'unavailable' };
    return api.harness.previewListDirectory({ url, path });
  },
  save: async (url: string, revision: string, content: string): Promise<PreviewSaveResult> => {
    if (!hasTransport()) return { ok: false, code: 'unavailable' };
    return api.harness.previewSave({ url, revision, content });
  },
  open: async (cwd: string, path: string, allowOutside = false): Promise<PreviewResult> => {
    if (!hasTransport()) return { ok: false, code: 'unavailable' };
    return (await api.harness.previewOpen({ cwd, path, allowOutside })) as unknown as PreviewResult;
  },
  web: async (url: string): Promise<PreviewResult> => {
    if (!hasTransport()) return { ok: false, code: 'unavailable' };
    return (await api.harness.previewWeb({ url })) as unknown as PreviewResult;
  },
  external: async (cwd: string, path: string, allowOutside = false): Promise<PreviewResult> => {
    if (!hasTransport()) {
      // Standalone browser previews have no access to local files. Preserve the user's web click.
      let url: URL;
      try {
        url = new URL(path);
      } catch {
        return { ok: false, code: 'unavailable' };
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        return { ok: false, code: 'invalid' };
      window.open(url.href, '_blank', 'noopener,noreferrer');
      return { ok: true, kind: 'external' };
    }
    return (await api.harness.previewExternal({
      cwd,
      path,
      allowOutside,
    })) as unknown as PreviewResult;
  },
  close: async (url: string) => {
    if (hasTransport()) await api.harness.previewClose({ url });
  },
};
