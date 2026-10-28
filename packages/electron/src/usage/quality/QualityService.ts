/**
 * 模型质量服务（docs/design/model-quality.md）：持有 QualityLedger，接收网关层 / CLI 层记录，
 * 提供查询、时间序列、请求明细、设置、清空与 CSV 导出（IPC 见 @nomi-ai/types QUALITY_IPC）。
 * 只存元数据，受「用量统计」总开关控制：关着时不记录。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { HostPorts } from '@nomi-ai/host-ports';
import {
  QUALITY_IPC,
  type QualityDimension,
  type QualityExportRequest,
  type QualityExportResult,
  type QualityFacets,
  type QualityQuery,
  type QualityRecord,
  type QualityRequestItem,
  type QualityRequestsQuery,
  type QualityResult,
  type QualitySeries,
  type QualitySeriesQuery,
  type QualitySettings,
  type QualityStats,
  type QualityTokens,
} from '@nomi-ai/types';

import type { AppEvents } from '../../core/appEvents';
import { t } from '../../i18n';
import { guardedHandle } from '../../security/guardedIpc';
import { writePrivateFile } from '../../utils/privateFile';

import {
  facetsOf,
  listRequests,
  queryQuality,
  seriesQuality,
  type QualityLabelOf,
} from './aggregate';
import { requestsCsv, statsCsv } from './csv';
import { fromGateway, isOutcome, sanitizeRecord, type GatewayQualityEvent } from './fromGateway';
import { DEFAULT_RETENTION_DAYS, QUALITY_RETENTION_CHOICES, QualityLedger } from './QualityLedger';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

const SETTINGS_FILE = 'settings.json';
const PRUNE_EVERY_MS = 6 * 3_600_000;
const DIMENSIONS: readonly QualityDimension[] = [
  'provider',
  'key',
  'model',
  'modelFamily',
  'client',
  'source',
  'protocol',
  'resolved',
  'outcome',
  'routeQuality',
  'loss',
];
const SERIES_METRICS: readonly QualitySeriesQuery['metric'][] = [
  'requests',
  'successRate',
  'failureRate',
  'cancelRate',
  'streamBreakRate',
  'cacheHitTokenRate',
  'ttft.p50',
  'ttft.p90',
  'ttft.p95',
  'tpot.p50',
  'e2e.p50',
  'e2e.p90',
  'e2e.p95',
  'outputTps.p50',
];
/** 单次查询最多跨的天数（防止渲染进程传入离谱范围） */
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
/** 变化广播的节流：界面据此重新查询，太频繁会让主进程反复聚合 */
const BROADCAST_MS = 5000;

export interface QualityServiceDeps {
  /** userData/usage/quality */
  dir: string;
  logger: Logger;
  /** 「用量统计」总开关；关着时不记录 */
  enabled?: () => boolean;
  /** 费用（USD）；未定价返回 undefined */
  cost?: (model: string, tokens: QualityTokens) => number | undefined;
  /** 维度取值的显示名（供应商名、Key 名或掩码） */
  labelOf?: QualityLabelOf;
  now?: () => number;
  /** 写盘攒批（ms），默认 500；0 = 立即写（测试） */
  flushMs?: number;
  /** 数据变化通知界面（ai:quality:changed） */
  events: AppEvents;
  /** 导出 CSV 的保存对话框 */
  ports: Pick<HostPorts, 'dialogs'>;
}

export class QualityService {
  readonly ledger: QualityLedger;
  private settings: QualitySettings = { retentionDays: DEFAULT_RETENTION_DAYS };
  private seq = 0;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** 数据版本：每次写入 / 清空 / 改保留期 +1，查询缓存据此失效 */
  private version = 0;
  /** 查询结果缓存（同一查询、数据没变时直接返回；30 天 × 每天 5000 次的聚合约数百毫秒） */
  private readonly cache = new Map<string, { version: number; value: unknown }>();

  constructor(private readonly d: QualityServiceDeps) {
    this.ledger = new QualityLedger({
      dir: d.dir,
      logger: d.logger,
      now: d.now,
      flushMs: d.flushMs,
    });
    this.loadSettings();
    this.ledger.prune(this.settings.retentionDays);
    this.pruneTimer = setInterval(
      () => this.ledger.prune(this.settings.retentionDays),
      PRUNE_EVERY_MS,
    );
    (this.pruneTimer as { unref?: () => void }).unref?.();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private enabled(): boolean {
    return this.d.enabled ? this.d.enabled() : true;
  }

  // ---------------------------------------------------------------- 记录

  /** 记一条（总开关关着时忽略）；返回是否记下 */
  add(rec: QualityRecord): boolean {
    if (!this.enabled()) return false;
    const clean = sanitizeRecord(rec);
    if (!clean) return false;
    this.ledger.append(clean);
    this.version++;
    this.changed();
    return true;
  }

  /** 旧「最近请求」（requests.json）的一次性导入：已经记下的数据，不再看总开关 */
  importLegacy(records: QualityRecord[]): void {
    let n = 0;
    for (const r of records) {
      const clean = sanitizeRecord(r);
      if (!clean) continue;
      this.ledger.append(clean);
      n++;
    }
    if (n) {
      // 同步写盘成功后再让调用方删源文件，避免写失败却丢数据（#127）
      if (!this.ledger.flushSync()) {
        throw new Error('quality ledger flush failed during legacy import');
      }
      this.version++;
      this.d.logger.info('quality: imported legacy gateway requests', { count: n });
      this.changed();
    }
  }

  /** 网关用量事件 → 网关层记录 */
  addGateway(e: GatewayQualityEvent): QualityRecord | null {
    if (!this.enabled()) return null;
    const rec = fromGateway(e, { id: `g-${e.startedAt}-${++this.seq}`, cost: this.d.cost });
    return this.add(rec) ? rec : null;
  }

  /** CLI 层记录（编排器在每一轮 / 每次模型调用结束时给出，§4.4） */
  addCli(rec: Omit<QualityRecord, 'id' | 'layer'> & { id?: string }): QualityRecord | null {
    if (!this.enabled()) return null;
    const full: QualityRecord = {
      ...rec,
      id: rec.id ?? `c-${rec.ts}-${++this.seq}`,
      layer: 'cli',
    };
    if (!isOutcome(full.outcome)) return null;
    if (full.cost === undefined && this.d.cost && full.model) {
      const c = this.d.cost(full.model, full.tokens ?? {});
      if (typeof c === 'number' && Number.isFinite(c)) full.cost = c;
    }
    return this.add(full) ? full : null;
  }

  // ---------------------------------------------------------------- 查询

  /** 校验渲染进程传来的范围（越界的夹到最近 MAX_RANGE_DAYS 天） */
  private range(q: { from?: unknown; to?: unknown }): { from: number; to: number } {
    const now = this.now();
    const to = typeof q.to === 'number' && Number.isFinite(q.to) ? q.to : now + 1;
    let from = typeof q.from === 'number' && Number.isFinite(q.from) ? q.from : to - DAY_MS;
    if (to - from > MAX_RANGE_DAYS * DAY_MS) from = to - MAX_RANGE_DAYS * DAY_MS;
    return { from, to };
  }

  private records(q: QualityQuery): QualityRecord[] {
    const { from, to } = this.range(q);
    // 对比上一周期时多读一段
    const span = to - from;
    return this.ledger.range(q.withPrevious ? from - span : from, to);
  }

  /** 同一查询、数据没变时用上次的结果；最多缓存 32 个 */
  private cached<T>(kind: string, q: object, compute: () => T): T {
    const key = `${kind}:${JSON.stringify(q)}`;
    const hit = this.cache.get(key);
    if (hit && hit.version === this.version) return hit.value as T;
    const value = compute();
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { version: this.version, value });
    return value;
  }

  query(raw: unknown): QualityResult {
    const q = this.cleanQuery(raw);
    return this.cached('q', q, () => queryQuality(this.records(q), q, this.d.labelOf));
  }

  /** 筛选项：这段时间里出现过的客户端 / 供应商 / 模型族 / Key */
  facets(raw: unknown): QualityFacets {
    const base = this.cleanQuery(raw);
    const q = { from: base.from, to: base.to, ...(base.layer ? { layer: base.layer } : {}) };
    return this.cached('f', q, () => facetsOf(this.ledger.range(q.from, q.to), q, this.d.labelOf));
  }

  series(raw: unknown): QualitySeries {
    const base = this.cleanQuery(raw);
    const r = (raw ?? {}) as Partial<QualitySeriesQuery>;
    const q: QualitySeriesQuery = {
      ...base,
      bucket: r.bucket === 'day' ? 'day' : 'hour',
      metric: SERIES_METRICS.includes(r.metric as never)
        ? (r.metric as QualitySeriesQuery['metric'])
        : 'requests',
    };
    return this.cached('s', q, () =>
      seriesQuality(this.ledger.range(q.from, q.to), q, this.d.labelOf),
    );
  }

  requests(raw: unknown): { items: QualityRequestItem[]; total: number } {
    const base = this.cleanQuery(raw);
    const r = (raw ?? {}) as Partial<QualityRequestsQuery>;
    const q: QualityRequestsQuery = {
      from: base.from,
      to: base.to,
      ...(base.layer ? { layer: base.layer } : {}),
      ...(base.filters ? { filters: base.filters } : {}),
      limit: typeof r.limit === 'number' ? r.limit : 100,
      ...(typeof r.offset === 'number' ? { offset: r.offset } : {}),
    };
    return listRequests(this.ledger.range(q.from, q.to), q, this.d.labelOf);
  }

  /** 最近的 n 条（「最近请求」兼容视图用） */
  private cleanQuery(raw: unknown): QualityQuery {
    const r = (raw ?? {}) as Partial<QualityQuery>;
    const { from, to } = this.range(r);
    const q: QualityQuery = { from, to };
    if (r.layer === 'cli' || r.layer === 'gateway') q.layer = r.layer;
    if (r.groupBy && DIMENSIONS.includes(r.groupBy)) q.groupBy = r.groupBy;
    if (Array.isArray(r.groupPath)) {
      const path = r.groupPath.filter((d): d is QualityDimension => DIMENSIONS.includes(d));
      if (path.length) q.groupPath = [...new Set(path)].slice(0, 3);
    }
    if (r.countBy === 'attempt') q.countBy = 'attempt';
    if (r.cancelInDenominator === true) q.cancelInDenominator = true;
    if (r.includeRejected === true) q.includeRejected = true;
    if (r.withPrevious === true) q.withPrevious = true;
    if (r.filters && typeof r.filters === 'object') {
      const f: QualityQuery['filters'] = {};
      for (const dim of DIMENSIONS) {
        const v = (r.filters as Record<string, unknown>)[dim];
        if (Array.isArray(v)) {
          const vals = v.filter((x): x is string => typeof x === 'string').slice(0, 50);
          if (vals.length) f[dim] = vals;
        }
      }
      if (Object.keys(f).length) q.filters = f;
    }
    return q;
  }

  // ---------------------------------------------------------------- 设置 / 清空 / 导出

  getSettings(): QualitySettings {
    return { ...this.settings };
  }

  setSettings(raw: unknown): QualitySettings {
    const days = (raw as Partial<QualitySettings> | null)?.retentionDays;
    if (QUALITY_RETENTION_CHOICES.includes(days as never)) {
      this.settings = { retentionDays: days as number };
      try {
        fs.mkdirSync(this.d.dir, { recursive: true, mode: 0o700 });
        writePrivateFile(
          path.join(this.d.dir, SETTINGS_FILE),
          JSON.stringify({ version: 1, ...this.settings }),
        );
      } catch (e) {
        this.d.logger.warn('quality settings save failed', { error: (e as Error).message });
      }
      this.ledger.prune(this.settings.retentionDays);
      this.version++;
      this.changed();
    }
    return this.getSettings();
  }

  private loadSettings(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.d.dir, SETTINGS_FILE), 'utf8')) as {
        retentionDays?: unknown;
      };
      if (QUALITY_RETENTION_CHOICES.includes(raw.retentionDays as never))
        this.settings = { retentionDays: raw.retentionDays as number };
    } catch {
      /* 第一次：默认 30 天 */
    }
  }

  async clear(): Promise<void> {
    await this.ledger.clear();
    this.version++;
    this.changed();
  }

  async exportCsv(raw: unknown): Promise<QualityExportResult> {
    const req = (raw ?? {}) as Partial<QualityExportRequest>;
    const stamp = new Date(this.now()).toISOString().slice(0, 10);
    let csv: string;
    let rows: number;
    let name: string;
    if (req.kind === 'table') {
      const res = this.query(req.query);
      // 多级分组按树的先序展开，名字前加层级缩进
      const flat: Array<QualityStats & { depth: number }> = [];
      const walk = (list: readonly QualityStats[], depth: number) => {
        for (const g of list) {
          flat.push({ ...g, depth });
          if (g.children) walk(g.children, depth + 1);
        }
      };
      walk(res.groups, 0);
      const groups = flat.length
        ? flat
        : [{ ...res.total, label: t('electron.common.all'), depth: 0 }];
      csv = statsCsv(groups);
      rows = groups.length;
      name = `nomi-model-quality-${stamp}.csv`;
    } else {
      const { items } = this.requests({ ...(req.query ?? {}), limit: 1000 });
      csv = requestsCsv(items, (dim, key) => this.d.labelOf?.(dim, key));
      rows = items.length;
      name = `nomi-requests-${stamp}.csv`;
    }
    const file = await pickSavePath(this.d.ports, name);
    if (!file) return { ok: false, rows };
    writePrivateFile(file, csv);
    return { ok: true, path: file, rows };
  }

  // ---------------------------------------------------------------- IPC

  private changed(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.d.events.publish(QUALITY_IPC.changed, null);
    }, BROADCAST_MS);
    (this.broadcastTimer as { unref?: () => void }).unref?.();
  }

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) =>
      guardedHandle(ch, fn, { owner: 'QualityService' });
    handle(QUALITY_IPC.query, (q) => this.query(q));
    handle(QUALITY_IPC.series, (q) => this.series(q));
    handle(QUALITY_IPC.requests, (q) => this.requests(q));
    handle(QUALITY_IPC.settingsGet, () => this.getSettings());
    handle(QUALITY_IPC.settingsSet, (s) => this.setSettings(s));
    handle(QUALITY_IPC.clear, async () => {
      await this.clear();
      return true;
    });
    handle(QUALITY_IPC.export, (r) => this.exportCsv(r));
    handle(QUALITY_IPC.facets, (q) => this.facets(q));
  }

  dispose(): void {
    this.ledger.dispose();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
  }
}

/** 保存对话框挂在当前获得焦点的窗口上（没有时独立弹出），取消返回 null */
function pickSavePath(
  ports: Pick<HostPorts, 'dialogs'>,
  defaultName: string,
): Promise<string | null> {
  return ports.dialogs.saveFile({
    title: t('electron.common.export-csv'),
    defaultPath: defaultName,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    parent: 'focused',
  });
}

let inst: QualityService | null = null;
export function initQualityService(d: QualityServiceDeps): QualityService {
  inst?.dispose();
  inst = new QualityService(d);
  return inst;
}
export function getQualityService(): QualityService | null {
  return inst;
}
