/**
 * 输入栏的「模型 · 思考深度」按钮（编程助手标签：Codex / Claude Code / Grok 等）。
 *
 * 界面与 Nomi 对话共用 ModelEffortChip（components/ModelControls/ModelEffortChip）；这里只做两件事：
 * 取模型目录（useCatalog）、把目录与网关数据交给编程助手的适配器（cliSource）。
 * 覆盖是标签级的，主进程在每轮启动时以进程级参数注入
 * （codex `-c model=...`、grok `-m ... --reasoning-effort ...`、claude `--model ... --effort ...`），
 * 不改写用户的全局 CLI 配置；每轮新进程的后端下一条消息即生效，Claude 长驻进程空闲时重启复用。
 */
import { Icon, isImageModel, t, type PickerModel } from '@nomi-ai/ui';
import { Cpu, RefreshCw } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  codingProviders,
  defaultSourceSwitch,
  isCliKind,
  providerOfRef,
  scopeCatalogToProvider,
  scopeCatalogToProviders,
  sessionModelGroups,
  tabSourceOf,
  thirdPartyRefOf,
} from '../../services/cliSource';
import type { HarnessTabMeta } from '../../services/harnessClient';
import { longContextFor } from '../../services/longContext';
import { pickerProviders, useGatewayState } from '../../services/nomiModel';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import { useCatalog, useCliModelEffortSource } from './cliSource';
import styles from './index.module.css';
import { ModelEffortChip } from './ModelEffortChip';

export { effortLabel } from './effortLabel';
export { useCatalog } from './cliSource';

/**
 * 目录还在从 CLI 读（Claude / Grok 冷启动要一两秒）：先放一个不可点的按钮占位，免得读完才突然冒出来。
 * 不支持切换的后端主进程立刻返回 null，所以只在读取超过一小会儿时才显示，避免一闪而过。
 */
const LoadingChip: React.FC<{ tab: HarnessTabMeta }> = ({ tab }) => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(id);
  }, []);
  if (!show) return null;
  const label = tab.modelOverride?.trim() || t('ui.providers-schedule.default-model');
  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.chip} ${styles.chipMuted}`}
        disabled
        aria-busy="true"
        aria-label={t(
          'ui.chat-settings.reading-the-model-list-from',
          ENDPOINT_NAME[tab.backend as keyof typeof ENDPOINT_NAME],
        )}
        data-testid="model-chip-loading"
      >
        <Icon icon={Cpu} />
        <span className={styles.label}>{label}</span>
        <span className={styles.spin}>
          <Icon icon={RefreshCw} size={12} />
        </span>
      </button>
    </div>
  );
};

/** 输入栏入口：无模型目录的后端不渲染；第三方来源列网关的模型 */
export const ModelControls: React.FC<{ tab: HarnessTabMeta }> = ({ tab }) => {
  const source = tabSourceOf(tab);
  const { catalog, refreshing, refresh } = useCatalog(tab.backend, source);
  const gateway = useGatewayState();
  const [open, setOpen] = useState(false);
  const thirdRef = source === 'thirdParty' ? thirdPartyRefOf(tab, tab.backend, gateway) : null;
  // 聊过的会话：原来的供应商与默认供应商不同时两家都列（全部模型）
  const groups = useMemo(
    () => (source === 'thirdParty' ? sessionModelGroups(tab, tab.backend, gateway) : null),
    [source, tab, gateway],
  );
  const sourceSwitch = useMemo(() => defaultSourceSwitch(tab, gateway), [tab, gateway]);
  // 官方来源：网关里的供应商也按标签列出来，可以直接换过去（与 Nomi 的模型选择器同形）
  const switchProviders = useMemo(
    () =>
      source !== 'thirdParty' && isCliKind(tab.backend) && gateway?.clients[tab.backend]
        ? codingProviders(gateway)
        : null,
    [source, tab.backend, gateway],
  );
  // 网关模型的能力与上下文窗口（与 Nomi 的模型选择器同一份数据）
  const modelMeta = useMemo(() => {
    const out = new Map<string, PickerModel>();
    for (const p of pickerProviders(gateway?.providers ?? []))
      for (const m of p.models) out.set(`${p.id}/${m.id}`, m);
    return out;
  }, [gateway]);
  const defaultProviderId = isCliKind(tab.backend)
    ? providerOfRef(gateway?.clients[tab.backend]?.models.main)
    : null;
  // 第三方：列所有供应商的模型，按供应商分标签；组（原来的 / 默认供应商）的说明放到标签上
  const providerTabs = useMemo(() => {
    if (!catalog || !thirdRef) return null;
    const has = new Set(catalog.models.map((m) => providerOfRef(m.id)));
    const label = new Map(groups?.map((g) => [g.id, g.label]));
    return codingProviders(gateway)
      .filter((p) => has.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, hint: label.get(p.id) }));
  }, [catalog, thirdRef, groups, gateway]);
  // 第三方目录来自网关：生图模型不能给编程助手用，不列
  const chatCatalog = useMemo(
    () =>
      catalog && thirdRef
        ? { ...catalog, models: catalog.models.filter((m) => !isImageModel(m.id)) }
        : catalog,
    [catalog, thirdRef],
  );
  const scoped = useMemo(
    () =>
      chatCatalog && thirdRef
        ? providerTabs && providerTabs.length > 1
          ? scopeCatalogToProviders(
              chatCatalog,
              providerTabs.map((p) => p.id),
              gateway,
            )
          : scopeCatalogToProvider(chatCatalog, thirdRef, gateway)
        : chatCatalog,
    [chatCatalog, thirdRef, providerTabs, gateway],
  );
  // 适配器只在实际渲染时调用（hook 不能跟在 return 后面）：用占位目录，禁用时也不显示
  const adapter = useCliModelEffortSource({
    tab,
    catalog: scoped ?? { backend: tab.backend, models: [], defaultModel: null },
    refreshing,
    onRefresh: refresh,
    open,
    long: longContextFor(tab, gateway),
    sessionRef: groups ? thirdRef : null,
    groups,
    sourceSwitch,
    providerTabs,
    switchProviders,
    defaultProviderId,
    modelMeta,
  });
  if (scoped === null) return null;
  if (scoped === undefined) return <LoadingChip tab={tab} />;
  return (
    <ModelEffortChip prefix="model" effortPrefix="effort" source={adapter} onOpenChange={setOpen} />
  );
};
