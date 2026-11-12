import { useSyncExternalStore } from 'react';

import { resourcePreviewClient, type PreviewResult } from '../../services/resourcePreviewClient';

export interface PreviewEditState {
  text: string;
  dirty: boolean;
  saving: boolean;
  error?: string;
}
/** Pending drafts survive tab/file changes. A serial writer prevents an older response
 * from marking later typing as saved. Only the kernel can compare-and-save a revision. */
export class PreviewEditSession {
  state: PreviewEditState;
  private baseline: string;
  private revision: string;
  private url: string;
  /** Workspace, real path and outside-workspace approval from the open that issued the edit grant. */
  private origin?: { cwd: string; path: string; allowOutside: boolean };
  // A reopened view may have a new read capability while an earlier writer is still
  // in flight. Keep that writer alive until it is no longer needed by any view/draft.
  private attachments = new Set<string>();
  private capabilities = new Set<string>();
  private reopened?: PreviewResult;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<boolean>;
  private listeners = new Set<() => void>();
  /** Diff editors save explicitly, but share close / conflict protection with file previews. */
  readonly autoSave: boolean;
  private onSaved?: () => void;
  noteOnSaved(callback?: () => void) {
    this.onSaved = callback;
  }
  constructor(result: PreviewResult, autoSave = true) {
    this.autoSave = autoSave;
    this.baseline = result.content ?? '';
    this.state = { text: this.baseline, dirty: false, saving: false };
    this.revision = result.revision!;
    this.url = result.url!;
    this.attachments.add(this.url);
    this.capabilities.add(this.url);
  }
  detach(url: string) {
    this.attachments.delete(url);
  }
  get disposable() {
    return !this.attachments.size && !this.state.dirty && !this.state.saving;
  }
  /** Remove ownership synchronously, before close IO can race with another open. */
  unusedCapabilities() {
    const unused = [...this.capabilities].filter(
      (url) => this.disposable || (!this.attachments.has(url) && url !== this.url),
    );
    unused.forEach((url) => this.capabilities.delete(url));
    return unused;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;
  private update(patch: Partial<PreviewEditState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  noteOrigin(cwd: string, path: string | undefined, allowOutside = false) {
    if (path) this.origin = { cwd, path, allowOutside };
  }
  /** Drop the unsaved text and keep the last saved baseline. Close and switch can proceed. */
  discardDraft() {
    if (this.pending) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.update({ text: this.baseline, dirty: false, saving: false, error: undefined });
  }
  attach(result: PreviewResult) {
    this.attachments.add(result.url!);
    this.capabilities.add(result.url!);
    if (this.pending) {
      // The snapshot may precede our write or already contain it. Neither renews the
      // active writer: a revision belongs to the capability that produced it.
      this.reopened = result;
      return;
    }
    // A failed draft is never replaced by a new disk load. If the baseline still matches,
    // renew its capability; otherwise retain the draft and show a real conflict.
    if (this.state.dirty && result.content !== this.baseline) {
      this.update({ error: 'conflict' });
      return;
    }
    this.url = result.url!;
    this.revision = result.revision!;
    if (!this.state.dirty) {
      this.baseline = result.content ?? '';
      this.update({ text: this.baseline, error: undefined });
    }
  }
  change = (text: string) => {
    this.update({ text, dirty: text !== this.baseline });
    if (this.timer) clearTimeout(this.timer);
    if (!this.autoSave || this.state.error) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 450);
  };
  flush = (): Promise<boolean> => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending)
      return this.pending.then((ok) => (ok && this.state.dirty ? this.flush() : ok));
    if (!this.state.dirty) return Promise.resolve(true);
    if (this.state.error === 'conflict') return Promise.resolve(false);
    const content = this.state.text;
    const baseline = this.baseline;
    this.update({ saving: true, error: undefined });
    this.pending = this.write(content, baseline).finally(() => {
      this.pending = undefined;
      this.reopened = undefined;
    });
    return this.pending.then((ok) => (ok && this.state.dirty ? this.flush() : ok));
  };
  private async write(content: string, baseline: string): Promise<boolean> {
    let result;
    try {
      result = await resourcePreviewClient.save(this.url, this.revision, content);
    } catch {
      this.update({ saving: false, error: 'write' });
      return false;
    }
    if (!result.ok && result.code === 'expired') {
      const renewed = await this.renewGrant(baseline);
      if (!renewed) return false;
      try {
        result = await resourcePreviewClient.save(this.url, this.revision, content);
      } catch {
        this.update({ saving: false, error: 'write' });
        return false;
      }
    }
    if (!result.ok || !result.revision) {
      this.update({ saving: false, error: result.code ?? 'write' });
      return false;
    }
    const observed = this.reopened?.content;
    const conflict = observed !== undefined && observed !== baseline && observed !== content;
    this.baseline = content;
    this.revision = result.revision;
    this.update({
      saving: false,
      dirty: conflict || this.state.text !== content,
      error: conflict ? 'conflict' : undefined,
    });
    this.onSaved?.();
    return !conflict;
  }
  /** Detaching a manual editor must not save its draft, but must let an existing save settle. */
  settleOnRelease() {
    return this.autoSave || this.pending ? this.flush() : Promise.resolve(true);
  }
  private dropCapability(url?: string) {
    if (!url || url === this.url || typeof resourcePreviewClient.close !== 'function') return;
    void resourcePreviewClient.close(url).catch(() => undefined);
  }
  /** One recovery per save. A second expired response is not chased. */
  private async renewGrant(baseline: string): Promise<boolean> {
    const reject = (error: string, url?: string) => {
      this.dropCapability(url);
      this.update({ saving: false, error });
      return false;
    };
    if (typeof resourcePreviewClient.renew === 'function') {
      let renewed;
      try {
        renewed = await resourcePreviewClient.renew(this.url);
      } catch {
        return reject('write');
      }
      if (renewed.ok) return this.adoptGrant(renewed, baseline);
      // The grant record is gone. Re-open the same path only then.
      // conflict / denied already proved the file must not be overwritten.
      if (renewed.code !== 'expired') return reject(renewed.code ?? 'expired', renewed.url);
    }
    const origin = this.origin;
    if (!origin || typeof resourcePreviewClient.open !== 'function') return reject('expired');
    let opened;
    try {
      opened = await resourcePreviewClient.open(origin.cwd, origin.path, origin.allowOutside);
    } catch {
      return reject('write');
    }
    if (opened.path && opened.path !== origin.path) return reject('conflict', opened.url);
    return this.adoptGrant(opened, baseline);
  }
  private adoptGrant(opened: PreviewResult, baseline: string): boolean {
    const reject = (error: string) => {
      this.dropCapability(opened.url);
      this.update({ saving: false, error });
      return false;
    };
    if (!opened.ok || !opened.editable || opened.truncated || !opened.url || !opened.revision) {
      return reject(opened.code && opened.code !== 'ok' ? opened.code : 'expired');
    }
    if ((opened.content ?? '') !== baseline) return reject('conflict');
    const previous = this.url;
    this.url = opened.url;
    this.revision = opened.revision;
    this.capabilities.add(opened.url);
    if (previous !== opened.url) this.dropCapability(previous);
    return true;
  }
}
const sessions = new Map<string, PreviewEditSession>();
const EMPTY: PreviewEditState = { text: '', dirty: false, saving: false };
const none = () => () => undefined;
export function acquirePreviewEdit(
  key: string,
  result: PreviewResult,
  autoSave = true,
): PreviewEditSession | undefined {
  if (!result.editable || !result.url || !result.revision || result.truncated) return;
  const session = sessions.get(key);
  if (session) {
    session.attach(result);
    return session;
  }
  const created = new PreviewEditSession(result, autoSave);
  sessions.set(key, created);
  return created;
}
export async function releasePreviewEdit(key: string, url: string) {
  const session = sessions.get(key);
  if (!session) {
    await resourcePreviewClient.close(url).catch(() => undefined);
    return;
  }
  session.detach(url);
  await session.settleOnRelease();
  await retirePreviewEdit(key, session);
}
async function retirePreviewEdit(key: string, session: PreviewEditSession) {
  // Retain failed drafts AND a writer borrowed by a reopened view. Retire the map
  // entry before awaiting close, so a new acquire cannot attach to a closing token.
  if (session.disposable && sessions.get(key) === session) sessions.delete(key);
  await Promise.all(
    session
      .unusedCapabilities()
      .map((unused) => resourcePreviewClient.close(unused).catch(() => undefined)),
  );
}
/** A retained Diff draft may be discarded while only its read-only Diff is mounted. */
export async function discardPreviewEdit(key: string, expected?: PreviewEditSession) {
  const session = sessions.get(key);
  if (!session || (expected && session !== expected)) return;
  session.discardDraft();
  await retirePreviewEdit(key, session);
}
/** Includes inactive drafts retained after an unsuccessful save on a previous tab. */
export function getPreviewEdits(keys: readonly string[]) {
  return keys.flatMap((key) => {
    const session = sessions.get(key);
    return session ? [{ key, session }] : [];
  });
}
/** A tab can be edited again while another tab's slower save is in flight. */
export async function flushPreviewEdits(keys: readonly string[]): Promise<string | undefined> {
  do {
    const results = await Promise.all(
      getPreviewEdits(keys).map(async ({ key, session }) => {
        const ok = await session.flush();
        await retirePreviewEdit(key, session);
        return { key, ok };
      }),
    );
    const failed = results.find((result) => !result.ok);
    if (failed) return failed.key;
  } while (
    getPreviewEdits(keys).some(({ session }) => session.state.dirty || session.state.saving)
  );
}
export function usePreviewEdit(session: PreviewEditSession | undefined) {
  return useSyncExternalStore(session?.subscribe ?? none, session?.snapshot ?? (() => EMPTY));
}
