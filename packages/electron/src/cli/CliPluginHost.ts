/**
 * 编程助手插件宿主（docs/design/cli-plugin-architecture.md §5.2、§7）：加载插件、校验清单、
 * 算有效能力（清单 ∩ 版本开关 ∩ 握手）、启停、出错隔离，并给界面一份注册表快照（`ai:cli:registry`）。
 *
 * - 清单校验失败的插件不注册（状态 invalid，写日志）；主进程实现的工厂抛错只影响这一个插件（failed）；
 * - 版本由 detect 读（每个 CLI 起一次 `--version`，后台进行，不阻塞启动）；版本变了重新算能力；
 * - 握手（驱动初始化时 CLI 报告的能力）只能关掉能力，不能打开清单没声明的；
 * - 内置插件的转录解析仍在主进程（historyTranscript.ts），加载时挂到 history.parse 上；
 * - 外部插件（L1 声明式，§5.9）：userData/cli-plugins/external/*.json，只有 ACP；没有主进程实现，
 *   编排层用通用 ACP 后端跑它（backend = 'external'），不接官方账号与网关。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BUILTIN_CLI_IDS } from '@nomi-ai/cli-plugins';
import { BUILTIN_PLUGINS } from '@nomi-ai/cli-plugins/main';
import {
  effectiveCapabilities,
  externalManifest,
  missingExternalEnv,
  probeAcp,
  renderExternalArgs,
  validateExternalSpec,
  validateManifest,
  type AcpProbeResult,
  type ChildLike,
  type CliCapabilities,
  type CliMainImpl,
  type CliManifest,
  type CliPlugin,
  type ExternalCliSpec,
} from '@nomi-ai/cli-sdk';

import type { AppEvents } from '../core/appEvents';
import { guardedHandle } from '../security/guardedIpc';

import { ExternalPluginStore } from './externalPlugins';
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
  /** 外部插件：清单内容（命令、参数模板、环境变量名）与当前环境里缺少的变量名 */
  external?: ExternalCliSpec & { missingEnv: string[] };
}

/** 「测试」按钮的结果：只做 ACP initialize 握手 */
export type ExternalTestResult =
  ({ ok: true; missingEnv: string[] } & AcpProbeResult) | { ok: false; errors: string[] };

export interface CliRegistrySnapshot {
  plugins: CliRegistryEntry[];
}

interface Loaded {
  plugin: CliPlugin;
  builtin: boolean;
  /** 外部插件的清单（内置插件没有） */
  external?: ExternalCliSpec;
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
  /** 注册表变化通知界面（ai:cli:registry-changed） */
  events: AppEvents;
  /**
   * 运行中检测到 CLI 换了版本（应用内升级或用户在终端里升级，P9.6）：编排层在空闲时重启续接。
   * 第一次读到版本（from = null）不算。
   */
  onVersionChange?: (id: string, from: string, to: string) => void;
  /** 外部插件清单所在目录；默认 <root>/external */
  externalDir?: string;
  /**
   * 起一个外部 CLI 进程（「测试」按钮用）：宿主负责 Windows 垫片、诊断记录与环境（spawnHarness）。
   * 测试注入。
   */
  spawnExternal?: (command: string, args: string[], cwd: string) => ChildLike;
  /** 外部插件被删除：编排层停掉用它的标签进程 */
  onExternalRemoved?: (id: string) => void;
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
  private readonly externals: ExternalPluginStore;

  constructor(private readonly d: CliPluginHostDeps) {
    this.externals = new ExternalPluginStore(
      d.externalDir ?? path.join(d.root, 'external'),
      this.reservedIds(),
    );
  }

  /** 外部插件不能占用的 id：内置插件（含测试注入的） */
  private reservedIds(): string[] {
    return [...new Set([...BUILTIN_CLI_IDS, ...Object.keys(this.d.plugins ?? {}), 'nomi'])];
  }

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
    this.loadExternals();
    this.changed();
    void this.refreshVersions();
  }

  /** 读外部插件清单：校验不过的登记为 invalid（界面显示错误、可删除），不影响其它插件 */
  private loadExternals(): void {
    for (const e of this.externals.load()) {
      if (this.loaded.has(e.id)) continue;
      this.loaded.set(e.id, this.externalEntry(e.id, e.spec, e.errors));
      if (e.errors.length)
        this.d.logger.warn('external cli plugin rejected', { id: e.id, errors: e.errors });
    }
  }

  private externalEntry(id: string, spec: ExternalCliSpec | null, errors: string[]): Loaded {
    const manifest = spec
      ? externalManifest(spec)
      : ({ id, displayName: id, icon: '' } as unknown as CliManifest);
    return {
      plugin: { manifest },
      builtin: false,
      ...(spec ? { external: spec } : {}),
      status: spec ? 'ready' : 'invalid',
      errors,
      impl: null,
      version: null,
      handshake: {},
    };
  }

  /** 外部插件的清单（就绪的才有）：编排层用它拉起进程 */
  externalSpec(id: string): ExternalCliSpec | undefined {
    const l = this.loaded.get(id);
    return l?.status === 'ready' ? l.external : undefined;
  }

  /** 添加 / 更新外部插件；返回注册表条目或校验错误 */
  addExternal(
    raw: unknown,
  ): { ok: true; entry: CliRegistryEntry } | { ok: false; errors: string[] } {
    // 内置插件的 id 由清单校验拒绝（reserved），这里不必再查
    const r = this.externals.save(raw);
    if ('errors' in r) return { ok: false, errors: r.errors };
    this.loaded.set(r.spec.id, this.externalEntry(r.spec.id, r.spec, []));
    this.d.logger.info('external cli plugin saved', { id: r.spec.id });
    this.changed();
    return { ok: true, entry: this.snapshot().plugins.find((p) => p.id === r.spec.id)! };
  }

  /** 删除外部插件（内置插件不能删）；正在用它的标签由编排层停掉进程，标签保留 */
  removeExternal(id: string): boolean {
    const l = this.loaded.get(id);
    // 只有外部插件能删（含校验不过、没有清单的坏文件）
    if (!l || l.builtin || (!l.external && l.status !== 'invalid')) return false;
    this.externals.remove(id);
    this.loaded.delete(id);
    this.d.logger.info('external cli plugin removed', { id });
    try {
      this.d.onExternalRemoved?.(id);
    } catch (e) {
      this.d.logger.warn('external cli plugin remove hook failed', { id, error: String(e) });
    }
    this.changed();
    return true;
  }

  /**
   * 试运行：起进程、只做 ACP initialize 握手、读出身份与能力后结束进程（不建会话、不发消息）。
   * 清单不必先保存；校验不过直接返回错误，不起进程。
   */
  async testExternal(raw: unknown, cwd: string): Promise<ExternalTestResult> {
    const errors = validateExternalSpec(raw, this.reservedIds());
    if (errors.length) return { ok: false, errors };
    if (!this.d.spawnExternal) return { ok: false, errors: ['spawn not available'] };
    const spec = raw as ExternalCliSpec;
    const env = this.d.env ?? process.env;
    const args = renderExternalArgs(spec.args, { cwd, home: this.d.home ?? os.homedir() });
    let child: ChildLike;
    try {
      child = this.d.spawnExternal(spec.command, args, cwd);
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
    }
    const spawnError = new Promise<never>((_, reject) =>
      child.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e)))),
    );
    try {
      const r = await Promise.race([probeAcp(child), spawnError]);
      return { ok: true, missingEnv: missingExternalEnv(spec, env), ...r };
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
    }
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
        // 外部插件的版本读不了（不知道它认不认 --version）；能力只由握手收窄
        if (l.status === 'invalid' || l.external) return;
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
        ...(l.external
          ? {
              external: {
                ...l.external,
                missingEnv: missingExternalEnv(l.external, this.d.env ?? process.env),
              },
            }
          : {}),
      });
    }
    return { plugins };
  }

  registerIpc(): void {
    const opts = { owner: 'CliPluginHost' };
    guardedHandle('ai:cli:registry', () => this.snapshot(), opts);
    guardedHandle('ai:cli:plugin-add', (raw) => this.addExternal(raw), opts);
    guardedHandle('ai:cli:plugin-remove', (id) => this.removeExternal(String(id)), opts);
    // 试运行在临时目录里做：不让对方 CLI 在用户的项目里留下任何东西
    guardedHandle(
      'ai:cli:plugin-test',
      async (raw) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-test-'));
        try {
          return await this.testExternal(raw, dir);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      opts,
    );
  }

  private changed(): void {
    this.d.events.publish('ai:cli:registry-changed', this.snapshot());
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
