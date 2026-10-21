/**
 * 供应商详情（docs/design/unified-gateway.md §4.2 末尾）：点供应商一行或「⋯」打开。
 * - 名称；Key 列表（上下移动即回退顺序、启用、改名、删除、一次贴多个新增；每个 Key 显示最近一次错误）；
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
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

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

/** Key 的显示名：用户起的名字原样显示，否则按顺序「主 Key / 备用 Key N」 */
export const keyName = (k: { name?: string }, i: number): string =>
  k.name || (i === 0 ? t('主 Key') : t('备用 Key {0}', String(i)));

interface KeyDraft {
  id: string;
  name: string;
  enabled: boolean;
  wire?: Wire;
}
interface NewKeyDraft {
  tmp: number;
  value: string;
  name: string;
  wire?: Wire;
}
interface Draft {
  name: string;
  keys: KeyDraft[];
  newKeys: NewKeyDraft[];
  models: GatewayModel[];
  fallback: string[];
  urls: Record<Wire, string>;
  modelMap: Array<{ from: string; to: string }>;
  headers: Array<{ name: string; value: string }>;
  userAgent: string;
  detected?: Partial<Record<Wire, StoredProbe>>;
}

const initDraft = (p: ProviderView): Draft => ({
  name: p.name,
  keys: p.keys.map((k) => ({ id: k.id, name: k.name ?? '', enabled: k.enabled, wire: k.wire })),
  newKeys: [],
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
  const newKeys = d.newKeys
    .filter((k) => k.value.trim())
    .map((k) => ({
      value: k.value.trim(),
      ...(k.name.trim() ? { name: k.name.trim() } : {}),
      ...(k.wire ? { wire: k.wire } : {}),
    }));
  return {
    id: p.id,
    name: d.name.trim() || p.name,
    ...(p.presetId ? { presetId: p.presetId } : {}),
    enabled: p.enabled,
    // 清空的地址写空串：主进程据此关闭该协议
    urls: Object.fromEntries(
      WIRES.filter((w) => d.urls[w].trim() || p.urls[w]).map((w) => [w, d.urls[w].trim()]),
    ),
    keys: d.keys.map((k) => ({
      id: k.id,
      enabled: k.enabled,
      ...(k.wire ? { wire: k.wire } : {}),
      // 名字留空就按顺序显示；原来有名字、现在清空时写空串
      ...(k.name.trim() || orig.get(k.id)?.name ? { name: k.name.trim() } : {}),
    })),
    ...(newKeys.length ? { newKeys } : {}),
    models: d.models,
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

/** 模型的能力标签 */
const ModelBadges: React.FC<{ m: GatewayModel }> = ({ m }) => (
  <>
    {m.reasoning && <span className={styles.badgeSoft}>{t('推理')}</span>}
    {m.vision && <span className={styles.badgeSoft}>{t('视觉')}</span>}
    {m.ctx ? <span className={styles.badgeMuted}>{formatContext(m.ctx)}</span> : null}
    {m.toolCalling === false && <span className={styles.badgeMuted}>{t('不支持工具调用')}</span>}
    {m.metaSource === 'default' && <span className={styles.badgeMuted}>{t('参数未知')}</span>}
  </>
);

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
  const dirty = useMemo(
    () => JSON.stringify(buildPayload(p, d)) !== JSON.stringify(buildPayload(p, initial)),
    [p, d, initial],
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
    { value: '', label: t('自动') },
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
    if (!window.confirm(t('删除 {0}？保存后生效。', label))) return;
    patch({ keys: d.keys.filter((_, n) => n !== i) });
  };
  const addKeys = () => {
    const known = new Set(d.newKeys.map((k) => k.value));
    const fresh = splitKeys(keysText).filter((v) => !known.has(v));
    if (!fresh.length) return;
    patch({
      newKeys: [...d.newKeys, ...fresh.map((value) => ({ tmp: ++tmpSeq, value, name: '' }))],
    });
    setKeysText('');
  };
  const setNewKey = (tmp: number, x: Partial<NewKeyDraft>) =>
    patch({ newKeys: d.newKeys.map((k) => (k.tmp === tmp ? { ...k, ...x } : k)) });

  /* ---------------- 模型 ---------------- */
  const setModel = (id: string, x: Partial<GatewayModel>) =>
    patch({ models: d.models.map((m) => (m.id === id ? { ...m, ...x } : m)) });
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
      if (!window.confirm(t('「{0}」是本机或局域网地址，允许 Nomi 访问它吗？', hp))) return false;
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
      const usableSaved = p.keys.some((k) => k.decryptable);
      const fresh = d.newKeys.map((k) => k.value.trim()).filter(Boolean);
      const r = await gatewayClient.detect({
        providerId: p.id,
        // 空串覆盖保存的地址：关掉的协议不再测
        urls: Object.fromEntries(WIRES.map((w) => [w, d.urls[w].trim()])),
        ...(!usableSaved && fresh.length ? { keys: fresh } : {}),
      });
      const have = new Set(d.models.map((m) => m.id));
      const added: GatewayModel[] = r.models
        .filter((id) => !have.has(id))
        .map((id) => ({
          id,
          enabled: false,
          ...(NON_CHAT.test(id) ? { toolCalling: false } : {}),
        }));
      setD((cur) => ({ ...cur, models: [...cur.models, ...added], detected: storedProbes(r) }));
      setDetectedUrls(JSON.stringify(d.urls));
      const ok = WIRES.filter((w) => r.wires[w]?.ok).map((w) => WIRE_LABEL[w]);
      const wiresText = ok.length ? t('可用协议：{0}', ok.join(' / ')) : t('所有协议都不可用');
      const modelsText = t('新发现 {0} 个模型（默认不启用）', String(added.length));
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
          {t('删除供应商')}
        </Button>
      )}
      {!readOnly && dirty && <span className={styles.help}>{t('有未保存的改动')}</span>}
      <Button size="sm" variant="secondary" onClick={onClose} data-testid="provider-detail-cancel">
        {readOnly ? t('关闭') : t('取消')}
      </Button>
      {!readOnly && (
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || busy !== null}
          onClick={() => void save()}
          data-testid="provider-detail-save"
        >
          {t('保存')}
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
              <span className={styles.badgeMuted}>{t('环境变量')}</span>
            </span>
          ) : (
            t('编辑「{0}」', providerDisplayName(p.name))
          )
        }
        footer={footer}
        data-testid="provider-detail"
      >
        <div className={styles.detailBody} ref={bodyRef}>
          {readOnly && (
            <p className={styles.help} data-testid="provider-detail-readonly">
              {t('这个供应商来自环境变量，只能查看；要修改请改环境变量后重启 Nomi。')}
            </p>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          {!readOnly && (
            <label className={styles.field}>
              <span>{t('名称')}</span>
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
              {t('Key（按顺序回退）')}
            </h4>
            {!p.keys.length && !d.newKeys.length && (
              <span className={styles.muted}>{t('无需 Key')}</span>
            )}
            {(readOnly ? p.keys.map((k) => ({ ...k, name: k.name ?? '' })) : d.keys).map((k, i) => {
              const view = p.keys.find((x) => x.id === k.id);
              const label = keyName({ name: k.name || view?.name }, i);
              return (
                <div key={k.id} className={styles.keyItem} data-testid={`pd-key-${k.id}`}>
                  <div className={styles.keyRow}>
                    {!readOnly && (
                      <span className={styles.orderBtns}>
                        <IconButton
                          size="sm"
                          label={t('上移 {0}', label)}
                          icon={<Icon icon={ArrowUp} size={14} />}
                          disabled={i === 0}
                          onClick={() => moveKey(i, -1)}
                          data-focus-id={`key-${k.id}-up`}
                          data-testid={`pd-key-up-${k.id}`}
                        />
                        <IconButton
                          size="sm"
                          label={t('下移 {0}', label)}
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
                        aria-label={t('{0} 的名称', label)}
                      />
                    )}
                    <code className={styles.masked}>{view?.masked}</code>
                    {!readOnly && (
                      <>
                        <Switch
                          checked={k.enabled}
                          onChange={(v) => setKey(i, { enabled: v })}
                          aria-label={t('启用 {0}', label)}
                        />
                        <IconButton
                          size="sm"
                          label={t('删除 {0}', label)}
                          icon={<Icon icon={Trash2} size={14} />}
                          onClick={() => deleteKey(i)}
                          data-testid={`pd-key-delete-${k.id}`}
                        />
                      </>
                    )}
                  </div>
                  {view && !view.decryptable && (
                    <span className={styles.errorText}>{t('无法解密，请重新填写')}</span>
                  )}
                  {view?.lastError && (
                    <span className={styles.errorText} data-testid={`pd-key-error-${k.id}`}>
                      {view.lastError}
                    </span>
                  )}
                </div>
              );
            })}
            {d.newKeys.map((k) => (
              <div key={k.tmp} className={styles.keyRow} data-testid="pd-new-key">
                <span className={styles.badgeSoft}>{t('新')}</span>
                <Input
                  size="sm"
                  className={styles.keyNameInput}
                  value={k.name}
                  placeholder={t('名称（可选）')}
                  onChange={(e) => setNewKey(k.tmp, { name: e.target.value })}
                  aria-label={t('新 Key 的名称')}
                />
                <code className={styles.masked}>
                  {k.value.length > 8 ? `${k.value.slice(0, 3)}…${k.value.slice(-4)}` : '…'}
                </code>
                <IconButton
                  size="sm"
                  label={t('移除这个新 Key')}
                  icon={<Icon icon={Trash2} size={14} />}
                  onClick={() => patch({ newKeys: d.newKeys.filter((x) => x.tmp !== k.tmp) })}
                />
              </div>
            ))}
            {!readOnly && (
              <div className={styles.addKeys}>
                <Textarea
                  rows={2}
                  value={keysText}
                  onChange={(e) => setKeysText(e.target.value)}
                  placeholder={t('添加 Key：每行一个，按顺序排在已有 Key 之后')}
                  aria-label={t('添加 Key')}
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
                  {t('添加')}
                </Button>
              </div>
            )}
          </section>

          {/* ---------------- 模型 ---------------- */}
          <section className={styles.section} aria-labelledby="pd-models">
            <div className={styles.sectionHead}>
              <h4 id="pd-models" className={styles.groupTitle}>
                {t('模型')}
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
                  {t('刷新')}
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
                <div key={m.id} className={styles.modelRow} data-testid={`pd-model-${m.id}`}>
                  <label className={styles.modelCheck}>
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={m.enabled}
                      onChange={(e) => setModel(m.id, { enabled: e.target.checked })}
                    />
                    <span>{m.label ?? m.id}</span>
                  </label>
                  <ModelBadges m={m} />
                  {!readOnly && (
                    <IconButton
                      size="sm"
                      className={styles.rowEnd}
                      label={t('移除模型 {0}', m.id)}
                      icon={<Icon icon={Trash2} size={14} />}
                      onClick={() => patch({ models: d.models.filter((x) => x.id !== m.id) })}
                    />
                  )}
                </div>
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
                  placeholder={t('手动添加模型 id')}
                  aria-label={t('手动添加模型 id')}
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
                  {t('添加')}
                </Button>
              </div>
            )}
          </section>

          {/* ---------------- 回退链 ---------------- */}
          {!readOnly && (
            <section className={styles.section} aria-labelledby="pd-fallback">
              <h4 id="pd-fallback" className={styles.groupTitle}>
                {t('回退链')}
              </h4>
              <p className={styles.help}>{t('这个供应商的模型都失败时，按顺序改用下面的模型。')}</p>
              {d.fallback.map((ref, i) => (
                <div key={ref} className={styles.keyRow} data-testid={`pd-fallback-${i}`}>
                  <span className={styles.orderBtns}>
                    <IconButton
                      size="sm"
                      label={t('上移 {0}', ref)}
                      icon={<Icon icon={ArrowUp} size={14} />}
                      disabled={i === 0}
                      onClick={() => patch({ fallback: move(d.fallback, i, -1) })}
                      data-testid={`pd-fallback-up-${i}`}
                    />
                    <IconButton
                      size="sm"
                      label={t('下移 {0}', ref)}
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
                    label={t('从回退链移除 {0}', ref)}
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
                className={styles.picker}
                value={null}
                onChange={(ref) =>
                  ref && !d.fallback.includes(ref) && patch({ fallback: [...d.fallback, ref] })
                }
                placeholder={t('添加回退模型')}
                disabled={!fallbackPicker.length}
                aria-label={t('添加回退模型')}
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
              {t('高级')}
            </button>
            {advanced && (
              <div id="pd-advanced" className={styles.advBody}>
                <div className={styles.advGroup}>
                  <div className={styles.groupTitle}>{t('各协议地址（留空表示关闭这个协议）')}</div>
                  {WIRES.map((w) => (
                    <label key={w} className={styles.urlRow}>
                      <span className={styles.urlLabel}>{WIRE_LABEL[w]}</span>
                      <Input
                        size="sm"
                        value={d.urls[w]}
                        readOnly={readOnly}
                        onChange={(e) => patch({ urls: { ...d.urls, [w]: e.target.value } })}
                        placeholder={t('未启用')}
                        data-testid={`pd-url-${w}`}
                      />
                    </label>
                  ))}
                  {!readOnly && urlsChanged && (
                    <div className={styles.offer} role="status" data-testid="pd-urls-changed">
                      <span>{t('地址改了，建议重新检测一次。')}</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => void detect()}
                        data-testid="pd-redetect"
                      >
                        {t('重新检测')}
                      </Button>
                    </div>
                  )}
                </div>

                {!readOnly && (
                  <>
                    <div className={styles.advGroup}>
                      <div className={styles.groupTitle}>
                        {t('模型限定协议（都不勾 = 自动选择）')}
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
                                  aria-label={t('{0} 走 {1}', m.id, WIRE_LABEL[w])}
                                  data-testid={`pd-model-wire-${m.id}-${w}`}
                                />
                                <span>{WIRE_LABEL[w]}</span>
                              </label>
                            ))}
                          </div>
                        ))}
                    </div>

                    {(d.keys.length > 0 || d.newKeys.length > 0) && (
                      <div className={styles.advGroup}>
                        <div className={styles.groupTitle}>{t('Key 限定协议')}</div>
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
                                aria-label={t('{0} 限定的协议', label)}
                                data-testid={`pd-key-wire-${k.id}`}
                              />
                            </div>
                          );
                        })}
                        {d.newKeys.map((k) => (
                          <div key={k.tmp} className={styles.wireRow}>
                            <span className={styles.keyName}>{k.name || t('新 Key')}</span>
                            <Select
                              size="sm"
                              className={styles.wireSelect}
                              options={wireOptions}
                              value={k.wire ?? ''}
                              onChange={(e) =>
                                setNewKey(k.tmp, { wire: (e.target.value || undefined) as Wire })
                              }
                              aria-label={t('新 Key 限定的协议')}
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    <PairRows
                      title={t('模型映射（请求里的模型名 → 发给上游的模型名）')}
                      rows={d.modelMap.map((x) => [x.from, x.to] as const)}
                      placeholders={[t('请求的模型名'), t('上游模型名')]}
                      testId="pd-map"
                      onChange={(rows) =>
                        patch({ modelMap: rows.map(([from, to]) => ({ from, to })) })
                      }
                    />
                    <PairRows
                      title={t('自定义请求头')}
                      rows={d.headers.map((x) => [x.name, x.value] as const)}
                      placeholders={[t('名称'), t('值')]}
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
                        placeholder={t('默认')}
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
            label={t('删除第 {0} 行', String(i + 1))}
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
          {t('添加一行')}
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
          t('{0} 暂时不可用：{1}', WIRE_LABEL[w as Wire], x!.reason),
        ),
        ...Object.entries(learned.modelWire ?? {}).map(([m, ws]) =>
          t('{0} 只走 {1}', m, ws.map((w) => WIRE_LABEL[w]).join(' / ')),
        ),
        ...(learned.customToolsRefused ?? []).map((m) =>
          t('{0} 的 Responses 接口不接受自定义工具，改用转换', m),
        ),
        ...Object.entries(learned.droppedParams ?? {}).map(([w, ps]) =>
          t('{0} 不发送字段：{1}', WIRE_LABEL[w as Wire] ?? w, ps.join('、')),
        ),
      ]
    : [];
  return (
    <div className={styles.advGroup} data-testid="provider-learned">
      <div className={styles.groupTitle}>{t('自动学到的')}</div>
      {lines.length ? (
        lines.map((l) => (
          <span key={l} className={styles.muted}>
            {l}
          </span>
        ))
      ) : (
        <span className={styles.muted}>{t('还没有自动学到的状态')}</span>
      )}
      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={!lines.length}
          onClick={onClear}
          data-testid="provider-learned-clear"
        >
          {t('清除自动学到的')}
        </Button>
      </div>
    </div>
  );
};
