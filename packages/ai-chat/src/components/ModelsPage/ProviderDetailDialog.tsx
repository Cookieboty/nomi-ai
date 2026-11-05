/**
 * 供应商详情（docs/development/gateway.md 末尾）：点供应商一行或「⋯」打开。单栏，按对象组织：
 * - 连接：名称、各协议地址（只列填了的，其余在「添加协议地址」里；改了地址后提示重新检测）、
 *   Key 列表（上下移动即回退顺序、启用、改名、原位更换、删除、一次贴多个新增；每个 Key 的
 *   限定协议与限流在它自己的「设置」里；显示最近一次错误）；
 * - 模型：左边列表（勾选启用、手动添加、「刷新」重新列出：新发现的默认不启用，已有设置不变），
 *   右边是选中模型的全部设置（按哪个已知模型处理、上下文 / 标准窗口 / 输出上限、长上下文、
 *   实际请求名、限定协议）；
 * - 更多设置（折叠）：其它模型映射、自定义请求头、User-Agent、清除自动学到的状态。
 * 所有改动先进草稿，「保存」一次写回（ai:gateway:upsert-provider）；「取消」/ Esc 丢弃。
 * 环境变量提供的供应商只读。
 */
import {
  Button,
  Icon,
  IconButton,
  Input,
  Modal,
  ModalHostContext,
  Select,
  t,
  type SelectOption,
} from '@nomi-ai/ui';
import { Check, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  gatewayClient,
  hostPortOf,
  isPrivateUrl,
  WIRE_LABEL,
  WIRES,
  type GatewayModel,
  type LearnedState,
  type ProviderInput,
  type ProviderView,
  type StoredProbe,
  type Wire,
} from '../../services/gatewayClient';
import { providerDisplayName } from '../../services/providerClient';
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';
import { ModelDetailPanel, userLimit } from './ModelDetailPanel';
import { ProviderKeysSection } from './ProviderKeysSection';
import { ProviderModelsPanel } from './ProviderModelsPanel';
import { NON_CHAT, storedProbes } from './providerSetup';

/** Key 的显示名：用户起的名字原样显示，否则按顺序「主 Key / 备用 Key N」 */
export const keyName = (k: { name?: string }, i: number): string =>
  k.name || (i === 0 ? t('ui.models.primary-key') : t('ui.models.backup-key', String(i)));

interface KeyDraft {
  id: string;
  name: string;
  enabled: boolean;
  wire?: Wire;
  /** 只有本次新增的 Key 带明文；已有 Key 永不返回明文。 */
  value?: string;
  /** 已有 Key 正在更换成的新值（undefined = 没在更换；保存时在原位置换成新 Key，名称保留） */
  replace?: string;
  /** 并发上限 / 每分钟请求数（输入框文本，留空 = 不限） */
  maxConcurrency?: string;
  rpm?: string;
}

/** 限流输入框 → 正整数；留空 / 非法 = null（不限） */
export const limitOf = (s: string | undefined): number | null => {
  const v = (s ?? '').trim();
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 && n <= 100_000 ? n : null;
};

/** 草稿里这个 Key 要写入的新明文：新增的 Key，或填了新值的「更换」 */
const freshValue = (k: KeyDraft): string | undefined =>
  k.value?.trim() || k.replace?.trim() || undefined;

/** 名称框里贴进来的像是 Key 本身（一长串无空白、字母数字混排）：提示改用「更换」，免得明文当名称存下 */
export const looksLikeKey = (s: string): boolean => {
  const v = s.trim();
  return /^\S{20,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && /[-_]/.test(v);
};
interface Draft {
  name: string;
  keys: KeyDraft[];
  models: GatewayModel[];
  urls: Record<Wire, string>;
  modelMap: Array<{ from: string; to: string }>;
  headers: Array<{ name: string; value: string }>;
  userAgent: string;
  /** 用户填的 Base URL（原样保存、原样显示） */
  baseUrl: string;
  detected?: Partial<Record<Wire, StoredProbe>>;
}

const initDraft = (p: ProviderView): Draft => ({
  name: providerDisplayName(p.name),
  keys: p.keys.map((k) => ({
    id: k.id,
    name: k.name ?? '',
    enabled: k.enabled,
    wire: k.wire,
    maxConcurrency: k.maxConcurrency ? String(k.maxConcurrency) : '',
    rpm: k.rpm ? String(k.rpm) : '',
  })),
  models: p.models.map((m) => ({ ...m })),
  urls: Object.fromEntries(WIRES.map((w) => [w, p.urls[w] ?? ''])) as Record<Wire, string>,
  modelMap: (p.modelMap ?? []).map((x) => ({ ...x })),
  headers: Object.entries(p.headers ?? {}).map(([name, value]) => ({ name, value })),
  userAgent: p.userAgent ?? '',
  // 旧数据没存过 Base URL：从现有地址里取一个显示
  baseUrl: (
    p.baseUrl ??
    p.urls.chat ??
    p.urls.responses ??
    p.urls.messages ??
    p.urls.gemini ??
    ''
  ).trim(),
});

/** 草稿 → upsert-provider 的参数（也用来判断有没有改动） */
export function buildPayload(p: ProviderView, d: Draft): ProviderInput {
  const orig = new Map(p.keys.map((k) => [k.id, k]));
  const newKeys = d.keys
    .map((k, position) => ({ ...k, position, fresh: freshValue(k) }))
    .filter((k) => k.fresh)
    .map((k) => ({
      value: k.fresh!,
      position: k.position,
      enabled: k.enabled,
      ...(k.name.trim() ? { name: k.name.trim() } : {}),
      ...(k.wire ? { wire: k.wire } : {}),
      ...(limitOf(k.maxConcurrency) ? { maxConcurrency: limitOf(k.maxConcurrency) } : {}),
      ...(limitOf(k.rpm) ? { rpm: limitOf(k.rpm) } : {}),
    }));
  return {
    id: p.id,
    // 名称没改时保留原值（预设名是 key，显示时才翻译）
    name: !d.name.trim() || d.name.trim() === providerDisplayName(p.name) ? p.name : d.name.trim(),
    ...(p.presetId ? { presetId: p.presetId } : {}),
    enabled: p.enabled,
    // 清空的地址写空串：主进程据此关闭该协议
    urls: Object.fromEntries(
      WIRES.filter((w) => d.urls[w].trim() || p.urls[w]).map((w) => [w, d.urls[w].trim()]),
    ),
    // 更换了值的已有 Key 不在这里：主进程按 newKeys 的 position 在原位置放新 Key、丢掉旧的
    keys: d.keys
      .filter((k) => k.value === undefined && !freshValue(k))
      .map((k) => ({
        id: k.id,
        enabled: k.enabled,
        ...(k.wire ? { wire: k.wire } : {}),
        // 限流只在改了时才带（null = 清除）
        ...(limitOf(k.maxConcurrency) !== (orig.get(k.id)?.maxConcurrency ?? null)
          ? { maxConcurrency: limitOf(k.maxConcurrency) }
          : {}),
        ...(limitOf(k.rpm) !== (orig.get(k.id)?.rpm ?? null) ? { rpm: limitOf(k.rpm) } : {}),
        // 名字留空就按顺序显示；原来有名字、现在清空时写空串
        ...(k.name.trim() || orig.get(k.id)?.name ? { name: k.name.trim() } : {}),
      })),
    ...(newKeys.length ? { newKeys } : {}),
    // 生效值（effective）只用于显示，主进程会重算
    models: d.models.map(({ effective: _e, ...m }) => m),
    modelMap: d.modelMap
      .map((x) => ({ from: x.from.trim(), to: x.to.trim() }))
      .filter((x) => x.from && x.to),
    headers: Object.fromEntries(
      d.headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]),
    ),
    userAgent: d.userAgent.trim(),
    baseUrl: d.baseUrl.trim(),
    ...(d.detected ? { detected: d.detected } : {}),
  };
}

const move = <T,>(list: T[], i: number, dir: -1 | 1): T[] => {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

const splitKeys = (text: string): string[] => [
  ...new Set(
    text
      .split('\n')
      .map((k) => k.trim())
      .filter(Boolean),
  ),
];

interface Props {
  provider: ProviderView | null;
  allowedPrivateHosts: string[];
  onClose: () => void;
  onRemove: (p: ProviderView) => void;
}

/** 关闭即卸载：每次打开都从保存的状态重新开始草稿 */
export const ProviderDetailDialog: React.FC<Props> = (props) =>
  props.provider ? (
    <ProviderDetail key={props.provider.id} {...props} provider={props.provider} />
  ) : null;

let tmpSeq = 0;

const ProviderDetail: React.FC<Props & { provider: ProviderView }> = ({
  provider,
  allowedPrivateHosts,
  onClose,
  onRemove,
}) => {
  /** 已保存的状态：不关弹窗的保存（更换 Key 时回车）后换成保存结果，草稿从它重新开始 */
  const [p, setP] = useState(provider);
  // 外面刷新了（网关状态变化：清除自动学到的、Key 状态等）：跟着更新，草稿不动
  const [seenProvider, setSeenProvider] = useState(provider);
  if (provider !== seenProvider) {
    setSeenProvider(provider);
    setP(provider);
  }
  const readOnly = p.source === 'env';
  const [initial, setInitial] = useState(() => initDraft(p));
  const [d, setD] = useState<Draft>(initial);
  const [keysText, setKeysText] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<'save' | 'detect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 最近一次检测用的地址（改了地址但还没检测时提示重新检测） */
  const [detectedUrls, setDetectedUrls] = useState(() => JSON.stringify(initial.urls));
  const bodyRef = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | null>(null);

  const patch = (x: Partial<Draft>) => setD((cur) => ({ ...cur, ...x }));
  const initialPayload = useMemo(() => JSON.stringify(buildPayload(p, initial)), [p, initial]);
  const dirty = useMemo(
    () => JSON.stringify(buildPayload(p, d)) !== initialPayload,
    [p, d, initialPayload],
  );
  /** 包括输入框里填了、还没点「添加」的 Key（保存时一起存） */
  const changed = dirty || splitKeys(keysText).length > 0;
  const urlsChanged = JSON.stringify(d.urls) !== detectedUrls;
  const urlWires = WIRES.filter((w) => d.urls[w].trim());
  /** Base URL：只改它，各协议地址由检测推出来（逐协议改在「更多设置」里） */
  const base = d.baseUrl;
  const setBase = (v: string) => patch({ baseUrl: v });
  const [detectedBase, setDetectedBase] = useState(initial.baseUrl);
  const baseChanged = base.trim() !== detectedBase.trim();
  /** 列出来的协议地址：填了的，以及刚点「添加协议地址」加的空行；其余收在「添加」菜单里 */
  const [extraWires, setExtraWires] = useState<ReadonlySet<Wire>>(() => new Set());
  const shownWires = WIRES.filter((w) => d.urls[w].trim() || extraWires.has(w));
  const hiddenWires = WIRES.filter((w) => !shownWires.includes(w));
  const addWire = (w: Wire) => setExtraWires((cur) => new Set(cur).add(w));
  const removeWire = (w: Wire) => {
    setExtraWires((cur) => {
      const next = new Set(cur);
      next.delete(w);
      return next;
    });
    patch({ urls: { ...d.urls, [w]: '' } });
  };
  const models = readOnly ? p.models : d.models;
  const modelIds = useMemo(() => new Set(models.map((m) => m.id)), [models]);
  /** 右侧正在看的模型（默认第一个启用的） */
  const [selectedId, setSelectedId] = useState<string | null>(
    () => (p.models.find((m) => m.enabled) ?? p.models[0])?.id ?? null,
  );
  const selected = models.find((m) => m.id === selectedId) ?? models[0];
  /** 模型映射：列表里模型的那条在模型设置里改（实际请求名），其余的在「更多设置」 */
  const upstreamOf = (id: string) => d.modelMap.find((x) => x.from === id)?.to ?? '';
  const setUpstream = (id: string, to: string) =>
    patch({
      modelMap: [
        ...d.modelMap.filter((x) => x.from !== id),
        ...(to.trim() && to.trim() !== id ? [{ from: id, to }] : []),
      ],
    });
  const otherMap = d.modelMap.filter((x) => !modelIds.has(x.from));
  const wireOptions: SelectOption[] = [
    { value: '', label: t('ui.foundation.auto') },
    ...WIRES.map((w) => ({ value: w, label: WIRE_LABEL[w] })),
  ];

  // 上下移动后焦点留在同一个按钮上（键盘连续调整顺序）
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    bodyRef.current?.querySelector<HTMLButtonElement>(`[data-focus-id="${id}"]`)?.focus();
  }, [d.keys]);

  /* ---------------- Key ---------------- */
  const setKey = (i: number, x: Partial<KeyDraft>) =>
    patch({ keys: d.keys.map((k, n) => (n === i ? { ...k, ...x } : k)) });
  const moveKey = (i: number, dir: -1 | 1) => {
    const id = d.keys[i]!.id;
    patch({ keys: move(d.keys, i, dir) });
    const j = i + dir;
    const atEdge = j === 0 || j === d.keys.length - 1;
    refocus.current = `key-${id}-${atEdge ? (dir < 0 ? 'down' : 'up') : dir < 0 ? 'up' : 'down'}`;
  };
  const deleteKey = async (i: number) => {
    const k = d.keys[i]!;
    const label = keyName({ name: k.name || p.keys.find((x) => x.id === k.id)?.name }, i);
    const ok = await confirmDialog({
      message: t('ui.models.delete-this-takes-effect-when-you-save', label),
      danger: true,
    });
    if (!ok) return;
    patch({ keys: d.keys.filter((_, n) => n !== i) });
  };
  /** 输入框里还没点「添加」的 Key 接到草稿末尾 */
  const withTypedKeys = (cur: Draft): Draft => {
    const known = new Set(cur.keys.map((k) => k.value));
    const fresh = splitKeys(keysText).filter((v) => !known.has(v));
    if (!fresh.length) return cur;
    return {
      ...cur,
      keys: [
        ...cur.keys,
        ...fresh.map((value) => ({ id: `new-${++tmpSeq}`, value, name: '', enabled: true })),
      ],
    };
  };
  const addKeys = () => {
    const next = withTypedKeys(d);
    if (next === d) return;
    patch({ keys: next.keys });
    setKeysText('');
  };

  /* ---------------- 模型 ---------------- */
  // 引用稳定：模型列表可能有几百行（ModelRow 是 memo），输入框打字 / 勾选一个模型时其余行不重渲染
  const setModel = useCallback(
    (id: string, x: Partial<GatewayModel>) =>
      setD((cur) => ({
        ...cur,
        models: cur.models.map((m) => (m.id === id ? { ...m, ...x } : m)),
      })),
    [],
  );
  const removeModel = useCallback(
    (id: string) => setD((cur) => ({ ...cur, models: cur.models.filter((x) => x.id !== id) })),
    [],
  );
  /** 批量启用 / 停用（模型面板里「全部启用 / 全部停用」作用于当前筛选出来的） */
  const setModelsEnabled = useCallback((ids: ReadonlySet<string>, enabled: boolean) => {
    setD((cur) => ({
      ...cur,
      models: cur.models.map((m) => (ids.has(m.id) ? { ...m, enabled } : m)),
    }));
  }, []);
  const addModel = useCallback((id: string) => {
    setD((cur) =>
      cur.models.some((m) => m.id === id)
        ? cur
        : { ...cur, models: [...cur.models, { id, enabled: true }] },
    );
  }, []);
  const toggleModelWire = (m: GatewayModel, w: Wire, on: boolean) => {
    const cur = m.wires ?? [];
    const next = on ? WIRES.filter((x) => x === w || cur.includes(x)) : cur.filter((x) => x !== w);
    setModel(m.id, { wires: next.length ? next : undefined });
  };

  /** 本机 / 局域网地址先确认；拒绝则不检测 */
  const confirmPrivate = async (list: readonly string[]): Promise<boolean> => {
    for (const raw of list) {
      const u = raw.trim();
      const hp = isPrivateUrl(u) ? hostPortOf(u) : null;
      if (!hp || allowedPrivateHosts.includes(hp)) continue;
      const ok = await confirmDialog({
        message: t('ui.models.is-a-local-or-lan-address-allow-nomi', hp),
      });
      if (!ok) return false;
      await gatewayClient.confirmPrivateHost(hp);
    }
    return true;
  };

  /**
   * 重新探测：新列出的模型加进来但不启用，已有模型的设置不变。
   * base：按 Base URL 推出各协议地址再测，检测通过的协议写回草稿（没有一个可用时报错、不改）；
   * 不给 base 时按草稿里逐协议的地址测。返回更新后的草稿（失败 / 取消为 null），保存时接着用。
   */
  const detect = async (opts: { base?: string } = {}): Promise<Draft | null> => {
    setError(null);
    setNotice(null);
    setBusy('detect');
    try {
      const base = opts.base?.trim();
      if (!(await confirmPrivate(base ? [base] : urlWires.map((w) => d.urls[w])))) return null;
      const fresh = d.keys
        .filter((k) => k.enabled)
        .map(freshValue)
        .filter((v): v is string => !!v);
      const r = await gatewayClient.detect({
        providerId: p.id,
        // Base URL：主进程按它推出各协议地址（优先于保存的）；否则逐协议给，空串 = 关掉的协议不测
        ...(base
          ? { url: base }
          : { urls: Object.fromEntries(WIRES.map((w) => [w, d.urls[w].trim()])) }),
        savedKeyIds: d.keys
          .filter((k) => k.enabled && k.value === undefined && !freshValue(k))
          .map((k) => k.id),
        ...(fresh.length ? { keys: fresh } : {}),
      });
      const have = new Set(d.models.map((m) => m.id));
      const listed = (id: string) =>
        r.limits?.[id] ? { ...r.limits[id], metaSource: 'listed' as const } : {};
      const added: GatewayModel[] = r.models
        .filter((id) => !have.has(id))
        .map((id) => ({
          id,
          enabled: false,
          ...(NON_CHAT.test(id) ? { toolCalling: false } : {}),
          ...listed(id),
        }));
      // 已有模型：用户没手填过的，用这次模型列表返回的上限刷新（第 3 级）
      const refreshed = (m: GatewayModel): GatewayModel =>
        r.limits?.[m.id] && !userLimit(m, 'ctx') && !userLimit(m, 'maxOutput')
          ? { ...m, ctx: undefined, maxOutput: undefined, ...listed(m.id) }
          : m;
      if (base && !WIRES.some((w) => r.wires[w]?.ok)) {
        setError(t('ui.models.no-api-is-available'));
        return null;
      }
      const urls = base
        ? (Object.fromEntries(WIRES.map((w) => [w, r.urls[w] ?? ''])) as Draft['urls'])
        : d.urls;
      const next: Draft = {
        ...d,
        urls,
        models: [...d.models.map(refreshed), ...added],
        detected: storedProbes(r),
      };
      setD(next);
      setDetectedUrls(JSON.stringify(urls));
      if (base) {
        setDetectedBase(base);
        setExtraWires(new Set());
      }
      const ok = WIRES.filter((w) => r.wires[w]?.ok).map((w) => WIRE_LABEL[w]);
      const wiresText = ok.length
        ? t('ui.models.available-apis', ok.join(' / '))
        : t('ui.models.no-api-is-available');
      const modelsText = t('ui.models.new-models-found-disabled-by-default', String(added.length));
      setNotice(`${wiresText} · ${modelsText}`);
      return next;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  };
  /** Base URL 改了还没检测：回车 / 离开输入框时自动检测 */
  const detectBase = async (): Promise<Draft | null> =>
    base.trim() && baseChanged ? detect({ base }) : d;

  /** keepOpen：保存后留在弹窗里（更换 Key 时回车），草稿换成刚保存的状态 */
  const save = async (opts: { keepOpen?: boolean } = {}) => {
    // Base URL 改了没检测：先检测（用检测出来的各协议地址），检测不通过就不保存
    let cur = await detectBase();
    if (!cur) return;
    // 逐协议的地址改了没检测：按填的地址测一次，检测结果随地址一起存（列表按它显示哪些协议可用）
    if (!readOnly && !baseChanged && urlsChanged) {
      cur = await detect();
      if (!cur) return;
    }
    setError(null);
    setBusy('save');
    try {
      // 填了 Key 没点「添加」就保存：一起存上，不悄悄丢掉
      const savedView = await gatewayClient.upsertProvider(buildPayload(p, withTypedKeys(cur)));
      if (opts.keepOpen && savedView?.id) {
        const next = initDraft(savedView);
        setP(savedView);
        setInitial(next);
        setD(next);
        setKeysText('');
        setDetectedUrls(JSON.stringify(next.urls));
        setDetectedBase(next.baseUrl);
        setNotice(t('ui.voice-mascot.saved'));
        setBusy(null);
        return;
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const footer = (
    <div className={styles.dialogFooter}>
      {!readOnly && (
        <Button
          size="sm"
          variant="danger"
          className={styles.footerStart}
          onClick={() => onRemove(p)}
          data-testid="provider-detail-remove"
        >
          {t('ui.models.delete-provider')}
        </Button>
      )}
      {!readOnly && changed && (
        <span className={styles.help}>{t('ui.models.unsaved-changes')}</span>
      )}
      <Button size="sm" variant="secondary" onClick={onClose} data-testid="provider-detail-cancel">
        {readOnly ? t('ui.providers-schedule.close') : t('ui.foundation.cancel')}
      </Button>
      {!readOnly && (
        <Button
          size="sm"
          variant="primary"
          disabled={!changed || busy !== null}
          onClick={() => void save()}
          data-testid="provider-detail-save"
        >
          {t('ui.foundation.save')}
        </Button>
      )}
    </div>
  );

  return (
    <ModalHostContext.Provider value={null}>
      <Modal
        open
        onClose={onClose}
        size="xl"
        bodyClassName={styles.pdModalBody}
        title={
          readOnly ? (
            <span className={styles.titleRow}>
              {providerDisplayName(p.name)}
              <span className={styles.badgeMuted}>
                {t('ui.chat-settings.environment-variable')}
              </span>
            </span>
          ) : (
            t('ui.models.edit', providerDisplayName(p.name))
          )
        }
        footer={footer}
        data-testid="provider-detail"
      >
        <div className={styles.detailBody} ref={bodyRef}>
          {readOnly && (
            <p className={styles.help} data-testid="provider-detail-readonly">
              {t('ui.models.this-provider-comes-from-environment-variables-and-is')}
            </p>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          {/* ---------------- 连接：左边名称与地址，右边 Key ---------------- */}
          <div className={styles.pdConnect}>
            <section className={styles.pdCard} aria-labelledby="pd-address">
              <h4 id="pd-address" className={styles.groupTitle}>
                {t('ui.foundation.connect')}
              </h4>
              {!readOnly && (
                <label className={styles.field}>
                  <span>{t('ui.foundation.name')}</span>
                  <Input
                    size="sm"
                    value={d.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    data-testid="provider-detail-name"
                  />
                </label>
              )}
              <label className={styles.field}>
                <span>Base URL</span>
                <Input
                  size="sm"
                  value={base}
                  readOnly={readOnly}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => setBase(e.target.value)}
                  onBlur={() => void detectBase()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void detectBase();
                    }
                  }}
                  data-testid="pd-base-url"
                />
              </label>
              <div className={styles.wireBadges} data-testid="pd-wires">
                {busy === 'detect' ? (
                  <span className={styles.muted}>{t('ui.models.detecting-apis')}</span>
                ) : (
                  WIRES.map((w) => (
                    <span
                      key={w}
                      className={d.urls[w].trim() ? styles.badgeSoft : styles.badgeMuted}
                      title={d.urls[w].trim() || t('ui.models.api-not-available')}
                      data-ok={d.urls[w].trim() ? '' : undefined}
                      data-testid={`pd-wire-${w}`}
                    >
                      {d.urls[w].trim() && <Icon icon={Check} size={12} />}
                      {WIRE_LABEL[w]}
                    </span>
                  ))
                )}
              </div>
              <p className={styles.detailHint}>{t('ui.models.base-url-hint')}</p>
            </section>
            <section className={styles.pdCard}>
              <ProviderKeysSection
                keys={
                  readOnly
                    ? p.keys.map((k) => ({
                        id: k.id,
                        name: k.name ?? '',
                        enabled: k.enabled,
                        wire: k.wire,
                      }))
                    : d.keys
                }
                views={p.keys}
                readOnly={readOnly}
                keyName={keyName}
                looksLikeKey={looksLikeKey}
                onSet={setKey}
                onMove={moveKey}
                onDelete={(i) => void deleteKey(i)}
                text={keysText}
                onText={setKeysText}
                onAdd={addKeys}
                canAdd={splitKeys(keysText).length > 0}
                wireOptions={wireOptions}
                onCommit={() => void save({ keepOpen: true })}
              />
            </section>
          </div>

          {/* ---------------- 模型：左边列表，右边选中模型的设置 ---------------- */}
          <div className={styles.pdModels}>
            <ProviderModelsPanel
              models={models}
              readOnly={readOnly}
              busy={busy !== null}
              detecting={busy === 'detect'}
              notice={notice}
              onRefresh={() => void detect()}
              onSet={setModel}
              onSetMany={setModelsEnabled}
              onAdd={addModel}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
            <ModelDetailPanel
              model={selected}
              urlWires={urlWires}
              readOnly={readOnly}
              upstream={selected ? upstreamOf(selected.id) : ''}
              onSet={setModel}
              onUpstream={setUpstream}
              onToggleWire={toggleModelWire}
              onRemove={removeModel}
            />
          </div>

          {/* ---------------- 更多设置：请求头、User-Agent、其它模型映射、自动学到的 ---------------- */}
          <section className={styles.section}>
            <button
              type="button"
              className={styles.advToggle}
              aria-expanded={advanced}
              aria-controls="pd-advanced"
              onClick={() => setAdvanced((x) => !x)}
              data-testid="pd-advanced-toggle"
            >
              <Icon icon={advanced ? ChevronDown : ChevronRight} size={14} />
              {t('ui.models.more-settings')}
            </button>
            {advanced && (
              <div id="pd-advanced" className={styles.advBody}>
                <div className={styles.advGroup}>
                  <div className={styles.groupTitle}>{t('ui.models.per-api-addresses')}</div>
                  {shownWires.map((w) => (
                    <div key={w} className={styles.urlRow}>
                      <span className={styles.urlLabel}>{WIRE_LABEL[w]}</span>
                      <Input
                        size="sm"
                        value={d.urls[w]}
                        readOnly={readOnly}
                        onChange={(e) => patch({ urls: { ...d.urls, [w]: e.target.value } })}
                        placeholder="https://"
                        aria-label={t('ui.models.address-for', WIRE_LABEL[w])}
                        data-testid={`pd-url-${w}`}
                      />
                      {!readOnly && (
                        <IconButton
                          size="sm"
                          label={t('ui.models.remove-address', WIRE_LABEL[w])}
                          icon={<Icon icon={Trash2} size={14} />}
                          onClick={() => removeWire(w)}
                          data-testid={`pd-url-remove-${w}`}
                        />
                      )}
                    </div>
                  ))}
                  {!readOnly && hiddenWires.length > 0 && (
                    <div>
                      <Select
                        size="sm"
                        variant="ghost"
                        value=""
                        placeholder={t('ui.models.add-api-address')}
                        options={hiddenWires.map((w) => ({ value: w, label: WIRE_LABEL[w] }))}
                        onChange={(e) => e.target.value && addWire(e.target.value as Wire)}
                        aria-label={t('ui.models.add-api-address')}
                        data-testid="pd-url-add"
                      />
                    </div>
                  )}
                  {!readOnly && urlsChanged && (
                    <div className={styles.offer} role="status" data-testid="pd-urls-changed">
                      <span>
                        {t('ui.models.the-addresses-changed-detecting-again-is-recommended')}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => void detect()}
                        data-testid="pd-redetect"
                      >
                        {t('ui.models.detect-again')}
                      </Button>
                    </div>
                  )}
                </div>
                {!readOnly && (
                  <>
                    <PairRows
                      title={t('ui.models.other-model-mapping')}
                      rows={otherMap.map((x) => [x.from, x.to] as const)}
                      placeholders={[t('ui.models.requested-model'), t('ui.models.upstream-model')]}
                      testId="pd-map"
                      onChange={(rows) =>
                        patch({
                          modelMap: [
                            ...d.modelMap.filter((x) => modelIds.has(x.from)),
                            ...rows.map(([from, to]) => ({ from, to })),
                          ],
                        })
                      }
                    />
                    <PairRows
                      title={t('ui.models.custom-headers')}
                      rows={d.headers.map((x) => [x.name, x.value] as const)}
                      placeholders={[t('ui.foundation.name'), t('ui.models.value')]}
                      testId="pd-header"
                      onChange={(rows) =>
                        patch({ headers: rows.map(([name, value]) => ({ name, value })) })
                      }
                    />
                    <label className={styles.urlRow}>
                      <span className={styles.urlLabel}>User-Agent</span>
                      <Input
                        size="sm"
                        value={d.userAgent}
                        onChange={(e) => patch({ userAgent: e.target.value })}
                        placeholder={t('ui.providers-schedule.default')}
                        data-testid="pd-user-agent"
                      />
                    </label>
                  </>
                )}
                <LearnedInfo
                  learned={p.learned}
                  onClear={() =>
                    void gatewayClient.clearLearned(p.id).catch((e: Error) => setError(e.message))
                  }
                />
              </div>
            )}
          </section>
        </div>
      </Modal>
    </ModalHostContext.Provider>
  );
};

/** 两列的行编辑（模型映射、请求头） */
const PairRows: React.FC<{
  title: string;
  rows: ReadonlyArray<readonly [string, string]>;
  placeholders: [string, string];
  testId: string;
  onChange: (rows: Array<[string, string]>) => void;
}> = ({ title, rows, placeholders, testId, onChange }) => {
  const set = (i: number, col: 0 | 1, v: string) =>
    onChange(
      rows.map((r, n) => (n === i ? (col === 0 ? [v, r[1]] : [r[0], v]) : [r[0], r[1]])) as Array<
        [string, string]
      >,
    );
  return (
    <div className={styles.advGroup}>
      <div className={styles.groupTitle}>{title}</div>
      {rows.map((r, i) => (
        <div key={i} className={styles.pairRow}>
          <Input
            size="sm"
            value={r[0]}
            placeholder={placeholders[0]}
            aria-label={`${placeholders[0]} ${i + 1}`}
            onChange={(e) => set(i, 0, e.target.value)}
            data-testid={`${testId}-a-${i}`}
          />
          <span aria-hidden>→</span>
          <Input
            size="sm"
            value={r[1]}
            placeholder={placeholders[1]}
            aria-label={`${placeholders[1]} ${i + 1}`}
            onChange={(e) => set(i, 1, e.target.value)}
            data-testid={`${testId}-b-${i}`}
          />
          <IconButton
            size="sm"
            label={t('ui.models.delete-row', String(i + 1))}
            icon={<Icon icon={Trash2} size={14} />}
            onClick={() => onChange(rows.filter((_, n) => n !== i).map((x) => [x[0], x[1]]))}
          />
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange([...rows.map((x): [string, string] => [x[0], x[1]]), ['', '']])}
          data-testid={`${testId}-add`}
        >
          <Icon icon={Plus} size={14} />
          {t('ui.models.add-row')}
        </Button>
      </div>
    </div>
  );
};

/** 运行时学到的：哪些协议暂时不可用、哪些模型只走某些协议、去掉了哪些字段；可以清除重新学 */
const LearnedInfo: React.FC<{ learned?: LearnedState; onClear: () => void }> = ({
  learned,
  onClear,
}) => {
  const lines = learned
    ? [
        ...Object.entries(learned.wireDown ?? {}).map(([w, x]) =>
          t('ui.models.temporarily-unavailable', WIRE_LABEL[w as Wire], x!.reason),
        ),
        ...Object.entries(learned.modelWire ?? {}).map(([m, ws]) =>
          t('ui.models.only-uses', m, ws.map((w) => WIRE_LABEL[w]).join(' / ')),
        ),
        ...(learned.customToolsRefused ?? []).map((m) =>
          t('ui.models.s-responses-api-rejects-custom-tools-converting-instead', m),
        ),
        ...Object.entries(learned.droppedParams ?? {}).map(([w, ps]) =>
          t('ui.models.omits-fields', WIRE_LABEL[w as Wire] ?? w, ps.join('、')),
        ),
      ]
    : [];
  return (
    <div className={styles.advGroup} data-testid="provider-learned">
      <div className={styles.groupTitle}>{t('ui.models.learned-automatically')}</div>
      {lines.length ? (
        lines.map((l) => (
          <span key={l} className={styles.muted}>
            {l}
          </span>
        ))
      ) : (
        <span className={styles.muted}>{t('ui.models.nothing-learned-automatically-yet')}</span>
      )}
      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={!lines.length}
          onClick={onClear}
          data-testid="provider-learned-clear"
        >
          {t('ui.models.clear-what-was-learned')}
        </Button>
      </div>
    </div>
  );
};
