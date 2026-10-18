/**
 * 会话层的斜杠命令：发现 → adapter → 注册表 → 执行 → 卡片 / 发送。
 * 一个调用对应一个正在显示的会话（Nomi 主对话或某个 CLI 标签）。
 */
import { t } from '@nomi-ai/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { cliProviderClient } from '../services/cliProviderClient';
import { extClient } from '../services/extClient';
import { harnessClient, type SlashDiscoveryEntry } from '../services/harnessClient';
import { providerClient } from '../services/providerClient';
import type { ConversationBackend } from '../types/chat';
import type { ConvMessage } from '../types/conversation';
import { ENDPOINT_FULL } from '../utils/endpointBadge';

import { adapterFor, scopeOrderFor } from './adapters';
import { notice } from './cards';
import { loadSlashData } from './data';
import { buildRegistry, executeSlash } from './registry';
import type {
  SlashActions,
  SlashBridge,
  SlashCard,
  SlashCardInput,
  SlashCommand,
  SlashContext,
  SlashOutcome,
} from './types';

const MAX_CARDS_PER_SCOPE = 30;
const MAX_SCOPES = 24;

export interface SlashHookParams {
  backend: ConversationBackend;
  cwd: string;
  /** 卡片归属（Nomi 主对话 / 某个标签）；变化即切换卡片集合 */
  scopeKey: string;
  messages: readonly ConvMessage[];
  session: { id: string | null; running: boolean } | null;
  /** 把文本当作一条消息发出（运行中会排队） */
  send: (text: string) => void;
  newSession: () => void | Promise<void>;
  onOpenPlugins: () => void;
  onOpenProviders: () => void;
  onOpenSettings: () => void;
}

export interface SlashHook {
  bridge: SlashBridge;
  cards: SlashCard[];
  dismissCard: (id: string) => void;
  /** 当前端发现的项目 / 用户条目（插件面板用） */
  discovered: readonly SlashDiscoveryEntry[] | null;
  commands: SlashCommand[];
}

let cardSeq = 0;

export function useSlashCommands(p: SlashHookParams): SlashHook {
  const { backend, cwd, scopeKey } = p;
  // 发现结果按「端 + 目录」存放：切换端 / 目录后旧结果自动失效，不需要在 effect 里清空
  const dKey = `${backend}|${cwd}`;
  const [found, setFound] = useState<{
    key: string;
    entries: readonly SlashDiscoveryEntry[] | null;
  } | null>(null);
  const discovered = found?.key === dKey ? found.entries : null;
  const [nomiSkills, setNomiSkills] = useState<Array<{ name: string; description: string }>>([]);
  const [byScope, setByScope] = useState<Record<string, SlashCard[]>>({});
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  });

  // 发现：CLI 端读项目 / 用户目录（主进程只读文件名与 frontmatter）；Nomi 读自带 Skills
  const reqId = useRef(0);
  const refresh = useCallback(() => {
    const id = ++reqId.current;
    if (backend === 'nomi') {
      if (!extClient.available()) return;
      void extClient
        .skills()
        .then((l) => {
          if (id !== reqId.current) return;
          setNomiSkills(
            (Array.isArray(l) ? l : [])
              .filter((s) => s.enabled && !s.error)
              .map((s) => ({ name: s.name, description: s.description })),
          );
        })
        .catch(() => undefined);
      return;
    }
    if (!harnessClient.available() || !cwd) return;
    void harnessClient
      .slashDiscover(backend, cwd)
      .then((r) => {
        if (id === reqId.current)
          setFound({ key: dKey, entries: r && Array.isArray(r.entries) ? r.entries : null });
      })
      .catch(() => id === reqId.current && setFound({ key: dKey, entries: null }));
  }, [backend, cwd, dKey]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const raw = useMemo(
    () => adapterFor(backend, { backend, discovered, nomiSkills }),
    [backend, discovered, nomiSkills],
  );
  const order = useMemo(() => scopeOrderFor(backend), [backend]);
  const commands = useMemo(() => buildRegistry(raw, order), [raw, order]);

  const addCard = useCallback((command: string, input: SlashCardInput) => {
    const L = latest.current;
    const { title, actions, ...body } = input;
    const card: SlashCard = {
      id: `slash-${Date.now().toString(36)}-${++cardSeq}`,
      command,
      at: Date.now(),
      afterId: L.messages.length ? L.messages[L.messages.length - 1]!.id : null,
      backend: L.backend,
      title,
      body: body as SlashCard['body'],
      ...(actions ? { actions } : {}),
    };
    const key = L.scopeKey;
    setByScope((m) => {
      const next = { ...m, [key]: [...(m[key] ?? []), card].slice(-MAX_CARDS_PER_SCOPE) };
      const keys = Object.keys(next);
      if (keys.length > MAX_SCOPES) delete next[keys[0]!];
      return next;
    });
  }, []);

  const dismissCard = useCallback((id: string) => {
    setByScope((m) => {
      const key = latest.current.scopeKey;
      const list = m[key];
      if (!list?.some((c) => c.id === id)) return m;
      return { ...m, [key]: list.filter((c) => c.id !== id) };
    });
  }, []);

  const actions = useMemo<SlashActions>(
    () => ({
      newSession: async () => {
        const key = latest.current.scopeKey;
        setByScope((m) => {
          if (!m[key]) return m;
          const rest = { ...m };
          delete rest[key];
          return rest;
        });
        await latest.current.newSession();
      },
      openPlugins: () => latest.current.onOpenPlugins(),
      openProviders: () => latest.current.onOpenProviders(),
      openSettings: () => latest.current.onOpenSettings(),
      switchNomiModel: async (providerId, model) => {
        await providerClient.setActive(providerId, model);
      },
      activateCliProfile: async (id) => {
        const r = await cliProviderClient.activate(id);
        return r.ok ? { ok: true } : { ok: false, error: r.error ?? t('切换失败') };
      },
      deactivateCliProfile: async () => {
        const b = latest.current.backend;
        const r =
          b === 'dsh'
            ? await cliProviderClient.deactivateDsh()
            : await cliProviderClient.deactivate(b as 'claude' | 'codex' | 'grok');
        return r.ok ? { ok: true } : { ok: false, error: r.error ?? t('切换失败') };
      },
      gitDiff: async () => {
        try {
          return await harnessClient.gitDiff(latest.current.cwd);
        } catch (e) {
          return {
            ok: false,
            status: '',
            stat: '',
            diff: '',
            truncated: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },
      expand: (id, args) =>
        harnessClient.slashExpand(latest.current.backend, latest.current.cwd, id, args),
      nomiSkillBody: async (name) => {
        try {
          return (await extClient.skillGet(name)).body;
        } catch {
          return null;
        }
      },
      sendPlain: (text) => latest.current.send(text),
    }),
    [],
  );

  const bridge = useMemo<SlashBridge>(() => {
    const apply = (command: string, kind: SlashCommand['kind'] | undefined, o: SlashOutcome) => {
      if (o.type === 'card') addCard(command, o.card);
      else if (o.type === 'send') {
        latest.current.send(o.text);
        if (o.note) addCard(command, notice(t('提示'), o.note));
        else if (kind === 'expand')
          addCard(
            command,
            notice(
              t('已展开并发送'),
              t(
                '已把命令展开成 {0} 个字符的提示词，发给了 {1}。',
                o.text.length,
                ENDPOINT_FULL[latest.current.backend](),
              ),
            ),
          );
      }
    };
    return {
      compose: (extra) => buildRegistry([...raw, ...extra], order),
      refresh,
      run: async (text, all) => {
        const L = latest.current;
        const ctx: SlashContext = {
          backend: L.backend,
          cwd: L.cwd,
          messages: L.messages,
          session: L.session,
          commands: () => all,
          load: () => loadSlashData(L.backend),
          actions,
        };
        const r = await executeSlash(text, all, ctx);
        if (!r.handled)
          return { handled: false, ...(r.text !== undefined ? { text: r.text } : {}) };
        apply(r.command, r.kind, r.outcome);
        return { handled: true };
      },
    };
  }, [raw, order, refresh, addCard, actions]);

  const cards = useMemo(() => byScope[scopeKey] ?? [], [byScope, scopeKey]);
  return { bridge, cards, dismissCard, discovered, commands };
}
