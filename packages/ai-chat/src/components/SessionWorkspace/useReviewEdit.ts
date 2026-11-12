import { useEffect, useState } from 'react';

import { resourcePreviewClient, type PreviewResult } from '../../services/resourcePreviewClient';
import {
  acquirePreviewEdit,
  discardPreviewEdit,
  getPreviewEdits,
  releasePreviewEdit,
  usePreviewEdit,
} from '../ResourcePreview/previewEdits';

/** Embedded Diff drafts belong to their preview tab, not the mounted FileReview. */
export function useReviewEdit({
  key,
  path,
  rootsKey,
  enabled,
  onSaved,
}: {
  key?: string;
  path?: string;
  rootsKey: string;
  enabled: boolean;
  onSaved?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<{
    key?: string;
    loading: boolean;
    result?: PreviewResult;
  }>({ loading: false });
  const session = key ? getPreviewEdits([key])[0]?.session : undefined;
  const state = usePreviewEdit(session);
  useEffect(() => {
    session?.noteOnSaved(onSaved);
  }, [session, onSaved]);
  useEffect(() => {
    if (!key || !enabled || !path) return;
    let stale = false;
    let capability: string | undefined;
    let acquired = false;
    const run = async () => {
      setLoad({ key, loading: true });
      let result: PreviewResult = { ok: false, code: 'workspace' };
      for (const cwd of rootsKey ? rootsKey.split('\0') : []) {
        try {
          result = await resourcePreviewClient.open(cwd, path);
        } catch {
          result = { ok: false, code: 'read' };
        }
        if (stale) {
          if (result.url) void resourcePreviewClient.close(result.url).catch(() => undefined);
          return;
        }
        if (result.ok) {
          const edit = acquirePreviewEdit(key, result, false);
          if (edit) {
            edit.noteOrigin(cwd, result.path ?? path);
            acquired = true;
          }
          capability = result.url;
          break;
        }
        if (result.url) void resourcePreviewClient.close(result.url).catch(() => undefined);
        // A delegated worktree can disappear; only try the supplied, kernel-validated roots.
        if (!['missing', 'authorization', 'workspace', 'read'].includes(result.code ?? '')) break;
      }
      if (!stale) setLoad({ key, loading: false, result });
    };
    void run();
    return () => {
      stale = true;
      if (!capability) return;
      if (acquired) void releasePreviewEdit(key, capability);
      else void resourcePreviewClient.close(capability).catch(() => undefined);
    };
  }, [key, path, rootsKey, enabled, attempt]);
  return {
    session,
    state,
    loading: load.key === key && load.loading,
    result: load.key === key ? load.result : undefined,
    reload: () => setAttempt((old) => old + 1),
    discard: () => {
      if (key && session) void discardPreviewEdit(key, session);
    },
  };
}
