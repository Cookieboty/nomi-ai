/**
 * 编程助手插件宿主（docs/design/cli-plugin-architecture.md §5.2、§7）：加载插件、校验清单、
 * 算有效能力（清单 ∩ 版本开关 ∩ 握手）、启停、出错隔离，并给界面一份注册表快照（`ai:cli:registry`）。
 *
 * - 清单校验失败的插件不注册（状态 invalid，写日志）；主进程实现的工厂抛错只影响这一个插件（failed）；
 * - 版本由 detect 读（每个 CLI 起一次 `--version`，后台进行，不阻塞启动）；版本变了重新算能力；
 * - 握手（驱动初始化时 CLI 报告的能力）只能关掉能力，不能打开清单没声明的；
 * - 内置插件的转录解析仍在主进程（historyTranscript.ts），加载时挂到 history.parse 上。
 */
import os from 'node:os';
import path from 'node:path';

import { BUILTIN_PLUGINS } from '@nomi-ai/cli-plugins/main';
import {
  effectiveCapabilities,
  validateManifest,
  type CliCapabilities,
  type CliMainImpl,
  type CliManifest,
  type CliPlugin,
} from '@nomi-ai/cli-sdk';
import { BrowserWindow } from 'electron';

import { guardedHandle } from '../security/guardedIpc';

import { parseSemver } from './semver';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

export type PluginStatus = 'loading' | 'ready' | 'invalid' | 'failed';

/** 界面用的注册表条目（不含主进程实现） */
export interface CliRegistryEntry {
  id: string;
  displayName: string;
  icon: string;
  builtin: boolean;
  status: PluginStatus;
  /** 清单校验错误 / 工厂报错 */
  errors: string[];
  version: string | null;
  transport: CliManifest['transport'];
  ingress: CliManifest['ingress'];
  modelSwitch: CliManifest['modelSwitch'];
  /** 有效能力 = 清单 ∩ 版本开关 ∩ 握手 */
  capabilities: CliCapabilities;
}

export interface CliRegistrySnapshot {
  plugins: CliRegistryEntry[];
}

interface Loaded {
  plugin: CliPlugin;
  builtin: boolean;
  status: PluginStatus;
  errors: string[];
  impl: CliMainImpl | null;
  version: string | null;
  handshake: Partial<Record<keyof CliCapabilities, unknown>>;
}

export interface CliPluginHostDeps {
  logger: Logger;
  /** userData/cli-plugins：每个插件的数据目录在其下 */
  root: string;
  /** 默认全部内置插件；测试可注入 */
  plugins?: Record<string, CliPlugin>;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 读某个插件对应 CLI 的版本（null = 没装 / 读不出） */
  version?: (id: string) => Promise<string | null>;
  /** 宿主补上的能力（内置插件的转录解析等） */
  extend?: (id: string, impl: CliMainImpl) => CliMainImpl;
  broadcast?: (channel: string, payload: unknown) => void;
  /**
   * 运行中检测到 CLI 换了版本（应用内升级或用户在终端里升级，P9.6）：编排层在空闲时重启续接。
   * 第一次读到版本（from = null）不算。
   */
  onVersionChange?: (id: string, from: string, to: string) => void;
}

/** 版本是否满足范围：空格分隔的比较式（>=1.0.60 <2.0.0），全部满足才算 */
export function inRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  const cmp = (a: [number, number, number], b: [number, number, number]) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]! ? 1 : -1;
    return 0;
  };
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p) => {
    const m = /^(>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+)$/.exec(p);
    const b = m ? parseSemver(m[2]!) : null;
    if (!m || !b) return false;
    const c = cmp(v, b);
    switch (m[1]) {
      case '>=':
        return c >= 0;
      case '<=':
        return c <= 0;
      case '>':
        return c > 0;
      case '<':
        return c < 0;
      default:
        return c === 0;
    }
  });
}

export class CliPluginHost {
  private readonly loaded = new Map<string, Loaded>();
  private started = false;

  constructor(private readonly d: CliPluginHostDeps) {}

  /** 加载全部插件：校验清单、调用主进程实现的工厂；版本在后台读，读到后重新算能力 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const plugins = this.d.plugins ?? (BUILTIN_PLUGINS as Record<string, CliPlugin>);
    const builtin = !this.d.plugins;
    for (const [key, plugin] of Object.entries(plugins)) {
      const errors = validateManifest(plugin.manifest);
      const id = typeof plugin.manifest?.id === 'string' ? plugin.manifest.id : key;
      if (errors.length || this.loaded.has(id)) {
        const why = errors.length ? errors : [`duplicate plugin id ${id}`];
        this.d.logger.warn('cli plugin rejected', { id, errors: why });
        this.loaded.set(`${id}${this.loaded.has(id) ? `#${key}` : ''}`, {
          plugin,
          builtin,
          status: 'invalid',
          errors: why,
          impl: null,
          version: null,
          handshake: {},
        });
        continue;
      }
      const entry: Loaded = {
        plugin,
        builtin,
        status: 'loading',
        errors: [],
        impl: null,
        version: null,
        handshake: {},
      };
      this.loaded.set(id, entry);
      try {
        let impl = plugin.main
          ? await plugin.main({
              logger: this.d.logger,
              dataDir: path.join(this.d.root, id),
              home: this.d.home ?? os.homedir(),
              env: this.d.env ?? process.env,
              platform: this.d.platform ?? process.platform,
            })
          : null;
        if (impl && this.d.extend) impl = this.d.extend(id, impl);
        entry.impl = impl;
        entry.status = 'ready';
      } catch (e) {
        // 出错隔离：一个插件的工厂抛错不影响其它插件
        entry.status = 'failed';
        entry.errors = [e instanceof Error ? e.message : String(e)];
        this.d.logger.warn('cli plugin failed to start', { id, error: entry.errors[0] });
      }
    }
    this.changed();
    void this.refreshVersions();
  }

  /** 停止：丢掉主进程实现（驱动与进程由编排层自己回收） */
  stop(): void {
    for (const l of this.loaded.values()) l.impl = null;
    this.loaded.clear();
    this.started = false;
  }

  /** 重新读各 CLI 的版本（安装 / 升级之后调用）；版本变了才广播 */
  async refreshVersions(): Promise<void> {
    if (!this.d.version) return;
    let changed = false;
    await Promise.all(
      [...this.loaded.entries()].map(async ([id, l]) => {
        if (l.status === 'invalid') return;
        const v = await this.d.version!(id).catch(() => null);
        if (v !== l.version) {
          const from = l.version;
          l.version = v;
          changed = true;
          if (from && v)
            try {
              this.d.onVersionChange?.(id, from, v);
            } catch (e) {
              this.d.logger.warn('cli plugin version hook failed', { id, error: String(e) });
            }
        }
      }),
    );
    if (changed) this.changed();
  }

  /** 驱动握手报告的能力（如 ACP 的 promptCapabilities.image = false）：只能关掉能力 */
  setHandshake(id: string, caps: Partial<Record<keyof CliCapabilities, unknown>>): void {
    const l = this.loaded.get(id);
    if (!l) return;
    l.handshake = { ...l.handshake, ...caps };
    this.changed();
  }

  /** 已就绪插件的主进程实现（没有 / 失败返回 undefined） */
  impl(id: string): CliMainImpl | undefined {
    const l = this.loaded.get(id);
    return l?.status === 'ready' ? (l.impl ?? undefined) : undefined;
  }

  manifest(id: string): CliManifest | undefined {
    return this.loaded.get(id)?.plugin.manifest;
  }

  capabilities(id: string): CliCapabilities | undefined {
    const l = this.loaded.get(id);
    if (!l || l.status === 'invalid') return undefined;
    return effectiveCapabilities(l.plugin.manifest, {
      version: l.version,
      inRange,
      handshake: l.handshake,
    });
  }

  snapshot(): CliRegistrySnapshot {
    const plugins: CliRegistryEntry[] = [];
    for (const [id, l] of this.loaded) {
      const m = l.plugin.manifest;
      plugins.push({
        id,
        displayName: typeof m?.displayName === 'string' ? m.displayName : id,
        icon: typeof m?.icon === 'string' ? m.icon : '',
        builtin: l.builtin,
        status: l.status,
        errors: l.errors,
        version: l.version,
        transport: m?.transport,
        ingress: m?.ingress,
        modelSwitch: m?.modelSwitch,
        capabilities: this.capabilities(id) ?? {},
      });
    }
    return { plugins };
  }

  registerIpc(): void {
    guardedHandle('ai:cli:registry', () => this.snapshot(), { owner: 'CliPluginHost' });
  }

  private changed(): void {
    const snap = this.snapshot();
    if (this.d.broadcast) {
      this.d.broadcast('ai:cli:registry-changed', snap);
      return;
    }
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send('ai:cli:registry-changed', snap);
  }
}

let inst: CliPluginHost | null = null;

export function initCliPluginHost(d: CliPluginHostDeps): CliPluginHost {
  inst = new CliPluginHost(d);
  return inst;
}

export function getCliPluginHost(): CliPluginHost | null {
  return inst;
}
