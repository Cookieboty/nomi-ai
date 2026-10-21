/**
 * 会话层的斜杠命令：发现 → adapter → 注册表 → 执行 → 卡片 / 发送。
 * 一个调用对应一个正在显示的会话（Nomi 主对话或某个 CLI 标签）。
 */
import { createLogger, t } from '@nomi-ai/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { switchTabSource, tabSourceOf } from '../services/cliSource';
import { extClient } from '../services/extClient';
import { gatewayClient } from '../services/gatewayClient';
import {
  harnessClient,
  type HarnessTabMeta,
  type SlashDiscoveryEntry,
} from '../services/harnessClient';
import { setNomiModel } from '../services/nomiModel';
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

const log = createLogger('slash');

const MAX_CARDS_PER_SCOPE = 30;
const MAX_SCOPES = 24;

export interface SlashHookParams {
  backend: ConversationBackend;
  cwd: string;
  /** 卡片归属（Nomi 主对话 / 某个标签）；变化即切换卡片集合 */
  scopeKey: string;
  messages: readonly ConvMessage[];
  session: { id: string | null; running: boolean } | null;
  /** 当前会话的 CLI 标签 id；Nomi 主对话为 null / 省略 */
  tabId?: string | null;
  /** 把文本当作一条消息发给**当前**会话（运行中会排队）。只在没有 sendTo 时、且目标仍是当前会话才会用到 */
  send: (text: string) => void;
  /**
   * 把文本发给**指定**目标（与当前显示哪个会话无关）。返回 true = 已发出 / 已入队；
   * false = 目标已失效（标签关闭、被重置、Nomi 已换会话），什么都没发。
   */
  sendTo?: (target: SlashTarget, text: string) => boolean | Promise<boolean>;
  /** 目标标签是否还存在；不存在时迟到的结果只记日志，不再留提示卡 */
  tabExists?: (tabId: string) => boolean;
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

/**
 * 命令发起时固定下来的归属。异步结果（发送 / 卡片 / 错误提示 / 卡片按钮）都只认它，
 * 不再读「现在正显示哪个会话」——用户在命令执行期间切换标签是常态。
 */
export interface SlashTarget {
  /** 卡片归属（Nomi 主对话 / 某个标签） */
  scopeKey: string;
  backend: ConversationBackend;
  cwd: string;
  /** CLI 标签 id；Nomi 主对话为 null */
  tabId: string | null;
  /** 发起时间，仅用于排查 */
  startedAt: number;
}

const DROPPED = () => t('会话已关闭或已重置，结果已丢弃。');

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

  /** 组件卸载后迟到的结果一律丢弃 */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** 目标会话是否已经不存在（标签被关闭） */
  const isGone = useCallback((target: SlashTarget): boolean => {
    const L = latest.current;
    return !!target.tabId && !!L.tabExists && !L.tabExists(target.tabId);
  }, []);

  const addCard = useCallback(
    (target: SlashTarget, command: string, input: SlashCardInput) => {
      if (!mounted.current) return;
      if (isGone(target)) {
        log.info('slash result dropped: target tab closed', { command, tabId: target.tabId });
        return;
      }
      const L = latest.current;
      const { title, actions, ...body } = input;
      // 卡片出现在哪条消息之后：目标仍是当前显示的会话就用它最新的末条消息，否则用发起时的会话开头
      const shown = target.scopeKey === L.scopeKey;
      const card: SlashCard = {
        id: `slash-${Date.now().toString(36)}-${++cardSeq}`,
        command,
        at: Date.now(),
        afterId: shown && L.messages.length ? L.messages[L.messages.length - 1]!.id : null,
        backend: target.backend,
        title,
        body: body as SlashCard['body'],
        ...(actions ? { actions } : {}),
      };
      const key = target.scopeKey;
      setByScope((m) => {
        const next = { ...m, [key]: [...(m[key] ?? []), card].slice(-MAX_CARDS_PER_SCOPE) };
        const keys = Object.keys(next);
        if (keys.length > MAX_SCOPES) delete next[keys[0]!];
        return next;
      });
    },
    [isGone],
  );

  /**
   * 把文本发给目标会话。true = 已发出 / 入队；false = 目标已失效，没有发送。
   * 失效时：标签仍在（被重置 / Nomi 换了会话）→ 在原会话留一张提示卡；标签已关闭 → 只记日志。
   */
  const deliver = useCallback(
    async (target: SlashTarget, command: string, text: string): Promise<boolean> => {
      if (!mounted.current) return false;
      const L = latest.current;
      let ok: boolean;
      try {
        ok = L.sendTo
          ? await L.sendTo(target, text)
          : // 没有显式目标接口：只有目标恰好就是当前会话才能发，绝不「转投」到别的会话
            target.scopeKey === L.scopeKey && (L.send(text), true);
      } catch (e) {
        log.warn('slash send failed', e);
        ok = false;
      }
      if (!ok) {
        log.info('slash send dropped: target invalid', { command, scopeKey: target.scopeKey });
        addCard(target, command, notice(t('提示'), DROPPED(), 'warn'));
      }
      return ok;
    },
    [addCard],
  );

  const dismissCard = useCallback((id: string) => {
    // 卡片 id 全局唯一：不依赖「现在显示哪个会话」
    setByScope((m) => {
      for (const [key, list] of Object.entries(m)) {
        if (list.some((c) => c.id === id)) return { ...m, [key]: list.filter((c) => c.id !== id) };
      }
      return m;
    });
  }, []);

  /** 每次执行各自一份 actions，全部绑定该次的 target（卡片按钮之后被点击也还是原会话） */
  const makeActions = useCallback(
    (target: SlashTarget): SlashActions => ({
      newSession: async () => {
        // 「新会话」只作用于当前显示的会话；目标已不是当前会话（用户切走了）就什么都不做
        if (target.scopeKey !== latest.current.scopeKey) return;
        const key = target.scopeKey;
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
      switchNomiModel: async (ref) => {
        await setNomiModel(ref);
      },
      useNomiEnvProvider: async (id, model) => {
        await gatewayClient.setAssignment('nomi', {
          models: { main: null as unknown as string },
        });
        await providerClient.setActive(id, model);
      },
      setTabSource: async (source, model) => {
        if (!target.tabId) throw new Error(t('会话已关闭或已重置'));
        const tabs = await harnessClient.tabs().catch(() => null);
        const tab = tabs?.tabs.find((x) => x.id === target.tabId);
        if (!tab) throw new Error(t('会话已关闭或已重置'));
        const L = latest.current;
        // 已有对话：标签有会话 id，或发起命令的会话就是当前显示的、里面有消息
        const hasMessages =
          !!tab.cliSessionId || (target.scopeKey === L.scopeKey && L.messages.length > 0);
        const r = await switchTabSource(tab, source, { model, hasMessages });
        return !!r;
      },
      tabModels: async () => {
        if (!target.tabId) return { catalog: null, current: null, source: 'official' as const };
        const tabs = await harnessClient.tabs().catch(() => null);
        const tab = tabs?.tabs.find((x) => x.id === target.tabId);
        const source = tabSourceOf(tab);
        const catalog = await harnessClient
          .modelCatalog(
            target.backend as HarnessTabMeta['backend'],
            source === 'thirdParty' ? { source } : {},
          )
          .catch(() => null);
        return { catalog, current: tab?.modelOverride?.trim() || null, source };
      },
      setTabModel: async (model) => {
        if (!target.tabId) throw new Error(t('会话已关闭或已重置'));
        await harnessClient.setTabModel(target.tabId, model);
      },
      gitDiff: async () => {
        try {
          return await harnessClient.gitDiff(target.cwd);
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
      expand: (id, args) => harnessClient.slashExpand(target.backend, target.cwd, id, args),
      nomiSkillBody: async (name) => {
        try {
          return (await extClient.skillGet(name)).body;
        } catch {
          return null;
        }
      },
      sendPlain: (text) => void deliver(target, text, text),
    }),
    [deliver],
  );

  const bridge = useMemo<SlashBridge>(() => {
    const apply = async (
      target: SlashTarget,
      command: string,
      kind: SlashCommand['kind'] | undefined,
      o: SlashOutcome,
    ) => {
      if (o.type === 'card') addCard(target, command, o.card);
      else if (o.type === 'send') {
        // 发送失败（目标已失效）时 deliver 已留下提示，这里不再追加「已展开并发送」
        if (!(await deliver(target, command, o.text))) return;
        if (o.note) addCard(target, command, notice(t('提示'), o.note));
        else if (kind === 'expand')
          addCard(
            target,
            command,
            notice(
              t('已展开并发送'),
              t(
                '已把命令展开成 {0} 个字符的提示词，发给了 {1}。',
                o.text.length,
                ENDPOINT_FULL[target.backend](),
              ),
            ),
          );
      }
    };
    return {
      compose: (extra) => buildRegistry([...raw, ...extra], order),
      refresh,
      scope: () => latest.current.scopeKey,
      run: async (text, all) => {
        const L = latest.current;
        // 入口固定归属：之后无论用户切到哪个标签，这条命令的一切产出都回到这里
        const target: SlashTarget = {
          scopeKey: L.scopeKey,
          backend: L.backend,
          cwd: L.cwd,
          tabId: L.tabId ?? null,
          startedAt: Date.now(),
        };
        const ctx: SlashContext = {
          backend: target.backend,
          cwd: target.cwd,
          messages: L.messages,
          session: L.session,
          commands: () => all,
          load: () => loadSlashData(target.backend, target.tabId),
          actions: makeActions(target),
        };
        const r = await executeSlash(text, all, ctx);
        if (!r.handled)
          return { handled: false, ...(r.text !== undefined ? { text: r.text } : {}) };
        await apply(target, r.command, r.kind, r.outcome);
        return { handled: true };
      },
    };
  }, [raw, order, refresh, addCard, deliver, makeActions]);

  const cards = useMemo(() => byScope[scopeKey] ?? [], [byScope, scopeKey]);
  return { bridge, cards, dismissCard, discovered, commands };
}
