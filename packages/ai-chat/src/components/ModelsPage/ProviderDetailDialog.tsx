/**
 * 供应商详情（docs/design/unified-gateway.md §4.2 末尾）：点供应商一行或「⋯」打开。
 * - 名称；Key 列表（上下移动即回退顺序、启用、改名、原位更换、删除、一次贴多个新增；
 *   每个 Key 显示最近一次错误）；
 * - 模型列表（勾选启用、手动添加、「刷新」重新列出：新发现的默认不启用，已有设置不变）；回退链；
 * - 「高级」折叠区：各协议地址（留空 = 关闭该协议）、模型限定协议、Key 限定协议、模型映射、
 *   自定义请求头、User-Agent、清除自动学到的状态（§7.4）；改了地址后提示重新检测。
 * 所有改动先进草稿，「保存」一次写回（ai:gateway:upsert-provider）；「取消」/ Esc 丢弃。
 * 环境变量提供的供应商只读。
 */
import {
  Button,
  formatContext,
  Icon,
  IconButton,
  Input,
  Modal,
  ModalHostContext,
  ModelPicker,
  Select,
  Switch,
  Textarea,
  t,
  type SelectOption,
} from '@nomi-ai/ui';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { pickerProviders } from '../../services/nomiModel';
import { providerDisplayName } from '../../services/providerClient';

import { NON_CHAT, storedProbes } from './AddProviderDialog';
import styles from './index.module.css';
import { metaSourceLabel, ModelLimitsGroups, userLimit } from './ModelLimitsGroups';

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
  fallback: string[];
  urls: Record<Wire, string>;
  modelMap: Array<{ from: string; to: string }>;
  headers: Array<{ name: string; value: string }>;
  userAgent: string;
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
  fallback: [...(p.fallback ?? [])],
  urls: Object.fromEntries(WIRES.map((w) => [w, p.urls[w] ?? ''])) as Record<Wire, string>,
  modelMap: (p.modelMap ?? []).map((x) => ({ ...x })),
  headers: Object.entries(p.headers ?? {}).map(([name, value]) => ({ name, value })),
  userAgent: p.userAgent ?? '',
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
    fallback: d.fallback,
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

/** 模型的能力标签：上下文按主进程算出的生效值显示，悬停看来源 */
const ModelBadges: React.FC<{ m: GatewayModel }> = ({ m }) => {
  const eff = m.effective;
  const ctx = eff ? (eff.source === 'default' ? undefined : eff.ctx) : m.ctx;
  const unknown = eff ? eff.source === 'default' : m.metaSource === 'default';
  return (
    <>
      {(eff?.reasoning ?? m.reasoning) && (
        <span className={styles.badgeSoft}>{t('ui.models.reasoning')}</span>
      )}
      {(eff?.vision ?? m.vision) && (
        <span className={styles.badgeSoft}>{t('ui.models.vision')}</span>
      )}
      {ctx ? (
        <span
          className={styles.badgeMuted}
          title={eff ? t('ui.models.meta-source', metaSourceLabel(eff.source)) : undefined}
        >
          {formatContext(ctx)}
        </span>
      ) : null}
      {m.toolCalling === false && (
        <span className={styles.badgeMuted}>{t('ui.models.no-tool-calling')}</span>
      )}
      {unknown && (
        <span className={styles.badgeMuted} title={t('ui.models.limits-unknown-hint')}>
          {t('ui.models.limits-unknown')}
        </span>
      )}
    </>
  );
};

/** 模型列表的一行 */
const ModelRow = memo(function ModelRow({
  m,
  readOnly,
  onSet,
  onRemove,
}: {
  m: GatewayModel;
  readOnly: boolean;
  onSet: (id: string, x: Partial<GatewayModel>) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className={styles.modelRow} data-testid={`pd-model-${m.id}`}>
      <label className={styles.modelCheck}>
        <input
          type="checkbox"
          disabled={readOnly}
          checked={m.enabled}
          onChange={(e) => onSet(m.id, { enabled: e.target.checked })}
        />
        <span>{m.label ?? m.id}</span>
      </label>
      <ModelBadges m={m} />
      {!readOnly && (
        <IconButton
          size="sm"
          className={styles.rowEnd}
          label={t('ui.models.remove-model', m.id)}
          icon={<Icon icon={Trash2} size={14} />}
          onClick={() => onRemove(m.id)}
        />
      )}
    </div>
  );
});

interface Props {
  provider: ProviderView | null;
  providers: ProviderView[];
  allowedPrivateHosts: string[];
  showWire: boolean;
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
  provider: p,
  providers,
  allowedPrivateHosts,
  showWire,
  onClose,
  onRemove,
}) => {
  const readOnly = p.source === 'env';
  const [initial] = useState(() => initDraft(p));
  const [d, setD] = useState<Draft>(initial);
  const [keysText, setKeysText] = useState('');
  const [modelText, setModelText] = useState('');
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
  const urlsChanged = JSON.stringify(d.urls) !== detectedUrls;
  const picker = useMemo(() => pickerProviders(providers), [providers]);
  const fallbackPicker = useMemo(
    () =>
      picker
        .map((x) => ({
          ...x,
          models: x.models.filter((m) => !d.fallback.includes(`${x.id}/${m.id}`)),
        }))
        .filter((x) => x.models.length),
    [picker, d.fallback],
  );
  const refName = (ref: string) => {
    const i = ref.indexOf('/');
    const owner = providers.find((x) => x.id === ref.slice(0, i));
    return owner ? `${providerDisplayName(owner.name)} / ${ref.slice(i + 1)}` : ref;
  };
  const urlWires = WIRES.filter((w) => d.urls[w].trim());
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
  const deleteKey = (i: number) => {
    const k = d.keys[i]!;
    const label = keyName({ name: k.name || p.keys.find((x) => x.id === k.id)?.name }, i);
    if (!window.confirm(t('ui.models.delete-this-takes-effect-when-you-save', label))) return;
    patch({ keys: d.keys.filter((_, n) => n !== i) });
  };
  const addKeys = () => {
    const known = new Set(d.keys.map((k) => k.value));
    const fresh = splitKeys(keysText).filter((v) => !known.has(v));
    if (!fresh.length) return;
    patch({
      keys: [
        ...d.keys,
        ...fresh.map((value) => ({ id: `new-${++tmpSeq}`, value, name: '', enabled: true })),
      ],
    });
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
  const addModel = () => {
    const id = modelText.trim();
    if (!id) return;
    if (!d.models.some((m) => m.id === id)) patch({ models: [...d.models, { id, enabled: true }] });
    setModelText('');
  };
  const toggleModelWire = (m: GatewayModel, w: Wire, on: boolean) => {
    const cur = m.wires ?? [];
    const next = on ? WIRES.filter((x) => x === w || cur.includes(x)) : cur.filter((x) => x !== w);
    setModel(m.id, { wires: next.length ? next : undefined });
  };

  /** 本机 / 局域网地址先确认（§15）；拒绝则不检测 */
  const confirmPrivate = async (): Promise<boolean> => {
    for (const w of urlWires) {
      const u = d.urls[w].trim();
      const hp = isPrivateUrl(u) ? hostPortOf(u) : null;
      if (!hp || allowedPrivateHosts.includes(hp)) continue;
      if (!window.confirm(t('ui.models.is-a-local-or-lan-address-allow-nomi', hp))) return false;
      await gatewayClient.confirmPrivateHost(hp);
    }
    return true;
  };

  /** 用这个供应商的地址重新探测：新列出的模型加进来但不启用，已有模型的设置不变 */
  const detect = async () => {
    setError(null);
    setNotice(null);
    setBusy('detect');
    try {
      if (!(await confirmPrivate())) return;
      const fresh = d.keys
        .filter((k) => k.enabled)
        .map(freshValue)
        .filter((v): v is string => !!v);
      const r = await gatewayClient.detect({
        providerId: p.id,
        // 空串覆盖保存的地址：关掉的协议不再测
        urls: Object.fromEntries(WIRES.map((w) => [w, d.urls[w].trim()])),
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
      // 已有模型：用户没手填过的，用这次模型列表返回的上限刷新（§12.7.2 第 3 级）
      const refreshed = (m: GatewayModel): GatewayModel =>
        r.limits?.[m.id] && !userLimit(m, 'ctx') && !userLimit(m, 'maxOutput')
          ? { ...m, ctx: undefined, maxOutput: undefined, ...listed(m.id) }
          : m;
      setD((cur) => ({
        ...cur,
        models: [...cur.models.map(refreshed), ...added],
        detected: storedProbes(r),
      }));
      setDetectedUrls(JSON.stringify(d.urls));
      const ok = WIRES.filter((w) => r.wires[w]?.ok).map((w) => WIRE_LABEL[w]);
      const wiresText = ok.length
        ? t('ui.models.available-apis', ok.join(' / '))
        : t('ui.models.no-api-is-available');
      const modelsText = t('ui.models.new-models-found-disabled-by-default', String(added.length));
      setNotice(`${wiresText} · ${modelsText}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setError(null);
    setBusy('save');
    try {
      await gatewayClient.upsertProvider(buildPayload(p, d));
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
      {!readOnly && dirty && <span className={styles.help}>{t('ui.models.unsaved-changes')}</span>}
      <Button size="sm" variant="secondary" onClick={onClose} data-testid="provider-detail-cancel">
        {readOnly ? t('ui.providers-schedule.close') : t('ui.foundation.cancel')}
      </Button>
      {!readOnly && (
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || busy !== null}
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
        size="lg"
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

          {/* ---------------- Key ---------------- */}
          <section className={styles.section} aria-labelledby="pd-keys">
            <h4 id="pd-keys" className={styles.groupTitle}>
              {t('ui.models.keys-fallback-in-order')}
            </h4>
            {!d.keys.length && <span className={styles.muted}>{t('ui.models.no-key-needed')}</span>}
            {(readOnly ? p.keys.map((k) => ({ ...k, name: k.name ?? '' })) : d.keys).map((k, i) => {
              const view = p.keys.find((x) => x.id === k.id);
              const label = keyName({ name: k.name || view?.name }, i);
              const replacing = 'replace' in k && k.replace !== undefined;
              const nameIsKey = !readOnly && !!view && !replacing && looksLikeKey(k.name);
              return (
                <div
                  key={k.id}
                  className={styles.keyItem}
                  data-testid={
                    'value' in k && k.value !== undefined ? 'pd-new-key' : `pd-key-${k.id}`
                  }
                >
                  <div className={styles.keyRow}>
                    {!readOnly && (
                      <span className={styles.orderBtns}>
                        <IconButton
                          size="sm"
                          label={t('ui.models.move-up', label)}
                          icon={<Icon icon={ArrowUp} size={14} />}
                          disabled={i === 0}
                          onClick={() => moveKey(i, -1)}
                          data-focus-id={`key-${k.id}-up`}
                          data-testid={`pd-key-up-${k.id}`}
                        />
                        <IconButton
                          size="sm"
                          label={t('ui.models.move-down', label)}
                          icon={<Icon icon={ArrowDown} size={14} />}
                          disabled={i === d.keys.length - 1}
                          onClick={() => moveKey(i, 1)}
                          data-focus-id={`key-${k.id}-down`}
                          data-testid={`pd-key-down-${k.id}`}
                        />
                      </span>
                    )}
                    {readOnly ? (
                      <span className={styles.keyName}>{label}</span>
                    ) : (
                      <Input
                        size="sm"
                        className={styles.keyNameInput}
                        value={k.name}
                        placeholder={keyName({}, i)}
                        onChange={(e) => setKey(i, { name: e.target.value })}
                        aria-label={t('ui.models.name-of', label)}
                      />
                    )}
                    {'value' in k && typeof k.value === 'string' && (
                      <span className={styles.badgeSoft}>{t('ui.models.new')}</span>
                    )}
                    {replacing && (
                      <span className={styles.badgeSoft}>{t('ui.models.replacing')}</span>
                    )}
                    <code className={styles.masked}>
                      {'value' in k && typeof k.value === 'string'
                        ? k.value.length > 8
                          ? `${k.value.slice(0, 3)}…${k.value.slice(-4)}`
                          : '…'
                        : view?.masked}
                    </code>
                    {!readOnly && (
                      <>
                        {view && (
                          <IconButton
                            size="sm"
                            label={
                              replacing
                                ? t('ui.models.cancel-replacing', label)
                                : t('ui.models.replace', label)
                            }
                            icon={<Icon icon={KeyRound} size={14} />}
                            aria-pressed={replacing}
                            onClick={() => setKey(i, { replace: replacing ? undefined : '' })}
                            data-testid={`pd-key-replace-${k.id}`}
                          />
                        )}
                        <Switch
                          checked={k.enabled}
                          onChange={(v) => setKey(i, { enabled: v })}
                          aria-label={t('ui.foundation.enable', label)}
                        />
                        <IconButton
                          size="sm"
                          label={t('ui.knowledge-local.delete', label)}
                          icon={<Icon icon={Trash2} size={14} />}
                          onClick={() => deleteKey(i)}
                          data-testid={`pd-key-delete-${k.id}`}
                        />
                      </>
                    )}
                  </div>
                  {replacing && (
                    <Input
                      size="sm"
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      value={(k as KeyDraft).replace}
                      placeholder={t('ui.models.paste-the-new-key-it-replaces-when-you', label)}
                      onChange={(e) => setKey(i, { replace: e.target.value })}
                      aria-label={t('ui.models.new-value-for', label)}
                      data-testid={`pd-key-replace-input-${k.id}`}
                    />
                  )}
                  {nameIsKey && (
                    <span className={styles.errorText} data-testid={`pd-key-name-hint-${k.id}`}>
                      {t('ui.models.this-name-looks-like-a-key-the-name')}{' '}
                      <button
                        type="button"
                        className={styles.linkBtn}
                        onClick={() => setKey(i, { replace: k.name.trim(), name: '' })}
                        data-testid={`pd-key-name-to-replace-${k.id}`}
                      >
                        {t('ui.models.use-it-to-replace-this-key-instead')}
                      </button>
                    </span>
                  )}
                  {view && !view.decryptable && (
                    <span className={styles.errorText}>
                      {t('ui.models.can-t-be-decrypted-enter-it-again')}
                    </span>
                  )}
                  {view?.lastError && (
                    <span className={styles.errorText} data-testid={`pd-key-error-${k.id}`}>
                      {view.lastError}
                    </span>
                  )}
                </div>
              );
            })}
            {!readOnly && (
              <div className={styles.addKeys}>
                <Textarea
                  rows={2}
                  value={keysText}
                  onChange={(e) => setKeysText(e.target.value)}
                  placeholder={t('ui.models.add-keys-one-per-line-placed-after-the')}
                  aria-label={t('ui.models.add-keys')}
                  data-testid="pd-keys-input"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!splitKeys(keysText).length}
                  onClick={addKeys}
                  data-testid="pd-keys-add"
                >
                  <Icon icon={Plus} size={14} />
                  {t('ui.foundation.add')}
                </Button>
              </div>
            )}
          </section>

          {/* ---------------- 模型 ---------------- */}
          <section className={styles.section} aria-labelledby="pd-models">
            <div className={styles.sectionHead}>
              <h4 id="pd-models" className={styles.groupTitle}>
                {t('ui.foundation.model')}
              </h4>
              {!readOnly && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void detect()}
                  data-testid="pd-models-refresh"
                >
                  <Icon
                    icon={busy === 'detect' ? Loader2 : RefreshCw}
                    size={14}
                    className={busy === 'detect' ? styles.spin : undefined}
                  />
                  {t('ui.knowledge-local.refresh')}
                </Button>
              )}
            </div>
            {notice && (
              <p className={styles.help} role="status" data-testid="pd-detect-notice">
                {notice}
              </p>
            )}
            <div className={styles.modelList}>
              {(readOnly ? p.models : d.models).map((m) => (
                <ModelRow
                  key={m.id}
                  m={m}
                  readOnly={readOnly}
                  onSet={setModel}
                  onRemove={removeModel}
                />
              ))}
            </div>
            {!readOnly && (
              <div className={styles.addRow}>
                <Input
                  size="sm"
                  value={modelText}
                  onChange={(e) => setModelText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addModel();
                    }
                  }}
                  placeholder={t('ui.models.add-a-model-id-manually')}
                  aria-label={t('ui.models.add-a-model-id-manually')}
                  data-testid="pd-model-input"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!modelText.trim()}
                  onClick={addModel}
                  data-testid="pd-model-add"
                >
                  <Icon icon={Plus} size={14} />
                  {t('ui.foundation.add')}
                </Button>
              </div>
            )}
          </section>

          {/* ---------------- 回退链 ---------------- */}
          {!readOnly && (
            <section className={styles.section} aria-labelledby="pd-fallback">
              <h4 id="pd-fallback" className={styles.groupTitle}>
                {t('ui.models.fallback-chain')}
              </h4>
              <p className={styles.help}>
                {t('ui.models.when-this-provider-s-models-all-fail-use')}
              </p>
              {d.fallback.map((ref, i) => (
                <div key={ref} className={styles.keyRow} data-testid={`pd-fallback-${i}`}>
                  <span className={styles.orderBtns}>
                    <IconButton
                      size="sm"
                      label={t('ui.models.move-up', ref)}
                      icon={<Icon icon={ArrowUp} size={14} />}
                      disabled={i === 0}
                      onClick={() => patch({ fallback: move(d.fallback, i, -1) })}
                      data-testid={`pd-fallback-up-${i}`}
                    />
                    <IconButton
                      size="sm"
                      label={t('ui.models.move-down', ref)}
                      icon={<Icon icon={ArrowDown} size={14} />}
                      disabled={i === d.fallback.length - 1}
                      onClick={() => patch({ fallback: move(d.fallback, i, 1) })}
                      data-testid={`pd-fallback-down-${i}`}
                    />
                  </span>
                  <span className={styles.keyName}>{refName(ref)}</span>
                  <IconButton
                    size="sm"
                    className={styles.rowEnd}
                    label={t('ui.models.remove-from-the-fallback-chain', ref)}
                    icon={<Icon icon={Trash2} size={14} />}
                    onClick={() => patch({ fallback: d.fallback.filter((x) => x !== ref) })}
                    data-testid={`pd-fallback-remove-${i}`}
                  />
                </div>
              ))}
              <ModelPicker
                providers={fallbackPicker}
                showWire={showWire}
                size="sm"
                className={styles.fallbackAdd}
                value={null}
                onChange={(ref) =>
                  ref && !d.fallback.includes(ref) && patch({ fallback: [...d.fallback, ref] })
                }
                placeholder={t('ui.models.add-fallback-model')}
                disabled={!fallbackPicker.length}
                aria-label={t('ui.models.add-fallback-model')}
                data-testid="pd-fallback-add"
              />
            </section>
          )}

          {/* ---------------- 高级 ---------------- */}
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
              {t('ui.models.advanced')}
            </button>
            {advanced && (
              <div id="pd-advanced" className={styles.advBody}>
                <div className={styles.advGroup}>
                  <div className={styles.groupTitle}>
                    {t('ui.models.address-per-api-leave-empty-to-turn-that')}
                  </div>
                  {WIRES.map((w) => (
                    <label key={w} className={styles.urlRow}>
                      <span className={styles.urlLabel}>{WIRE_LABEL[w]}</span>
                      <Input
                        size="sm"
                        value={d.urls[w]}
                        readOnly={readOnly}
                        onChange={(e) => patch({ urls: { ...d.urls, [w]: e.target.value } })}
                        placeholder={t('ui.slash-commands.disabled')}
                        data-testid={`pd-url-${w}`}
                      />
                    </label>
                  ))}
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
                    <div className={styles.advGroup}>
                      <div className={styles.groupTitle}>
                        {t('ui.models.restrict-models-to-apis-none-checked-automatic')}
                      </div>
                      {d.models
                        .filter((m) => m.enabled || m.wires?.length)
                        .map((m) => (
                          <div key={m.id} className={styles.wireRow}>
                            <span className={styles.keyName}>{m.id}</span>
                            {urlWires.map((w) => (
                              <label key={w} className={styles.modelCheck}>
                                <input
                                  type="checkbox"
                                  checked={m.wires?.includes(w) ?? false}
                                  onChange={(e) => toggleModelWire(m, w, e.target.checked)}
                                  aria-label={t('ui.models.uses', m.id, WIRE_LABEL[w])}
                                  data-testid={`pd-model-wire-${m.id}-${w}`}
                                />
                                <span>{WIRE_LABEL[w]}</span>
                              </label>
                            ))}
                          </div>
                        ))}
                    </div>

                    <ModelLimitsGroups models={d.models} setModel={setModel} />

                    {d.keys.length > 0 && (
                      <div className={styles.advGroup}>
                        <div className={styles.groupTitle}>
                          {t('ui.models.restrict-keys-to-an-api')}
                        </div>
                        {d.keys.map((k, i) => {
                          const label = keyName(
                            { name: k.name || p.keys.find((x) => x.id === k.id)?.name },
                            i,
                          );
                          return (
                            <div key={k.id} className={styles.wireRow}>
                              <span className={styles.keyName}>{label}</span>
                              <Select
                                size="sm"
                                className={styles.wireSelect}
                                options={wireOptions}
                                value={k.wire ?? ''}
                                onChange={(e) =>
                                  setKey(i, { wire: (e.target.value || undefined) as Wire })
                                }
                                aria-label={t('ui.models.api-restriction-for', label)}
                                data-testid={`pd-key-wire-${k.id}`}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {d.keys.length > 0 && (
                      <div className={styles.advGroup}>
                        <div className={styles.groupTitle}>
                          {t('ui.models.key-limits-leave-blank-for-no-limit-extra')}
                        </div>
                        {d.keys.map((k, i) => {
                          const label = keyName(
                            { name: k.name || p.keys.find((x) => x.id === k.id)?.name },
                            i,
                          );
                          return (
                            <div key={k.id} className={styles.wireRow}>
                              <span className={styles.keyName}>{label}</span>
                              <Input
                                size="sm"
                                type="number"
                                min={1}
                                step={1}
                                inputMode="numeric"
                                className={styles.limitInput}
                                value={k.maxConcurrency ?? ''}
                                onChange={(e) => setKey(i, { maxConcurrency: e.target.value })}
                                placeholder={t('ui.models.concurrent')}
                                aria-label={t('ui.models.max-concurrent-requests', label)}
                                data-testid={`pd-key-conc-${k.id}`}
                              />
                              <Input
                                size="sm"
                                type="number"
                                min={1}
                                step={1}
                                inputMode="numeric"
                                className={styles.limitInput}
                                value={k.rpm ?? ''}
                                onChange={(e) => setKey(i, { rpm: e.target.value })}
                                placeholder={t('ui.models.per-minute')}
                                aria-label={t('ui.models.max-requests-per-minute', label)}
                                data-testid={`pd-key-rpm-${k.id}`}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <PairRows
                      title={t('ui.models.model-mapping-model-name-in-the-request-model')}
                      rows={d.modelMap.map((x) => [x.from, x.to] as const)}
                      placeholders={[t('ui.models.requested-model'), t('ui.models.upstream-model')]}
                      testId="pd-map"
                      onChange={(rows) =>
                        patch({ modelMap: rows.map(([from, to]) => ({ from, to })) })
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

/** 运行时学到的（§7.4）：哪些协议暂时不可用、哪些模型只走某些协议、去掉了哪些字段；可以清除重新学 */
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
