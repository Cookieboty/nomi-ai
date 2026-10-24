/**
 * 插件契约测试（docs/design/cli-plugin-architecture.md §9.1）：每个插件在自己的测试里跑一遍。
 * 不依赖测试框架：`checkPlugin` 返回问题列表（空 = 通过），vitest / jest 里断言它为空即可。
 *
 * 检查：
 * - 清单通过校验；
 * - 能力位与实现一致（声明了 resume 就必须有 history，声明了 officialAccount 就必须有 accounts…）；
 * - 启动注入确定（同样的输入两次结果一样）、不含明文密钥（只能引用环境变量名）；
 * - 权限档位与清单一致；账号目录的共享条目是相对路径；
 * - 历史夹具（fixtures/history/<version>/）全部能解析，消息数 / 标题与期望一致。
 */
import type { HarnessPermissionMode } from '../events';
import { validateManifest } from '../manifest';
import type { CliMainHost, CliMainImpl, CliPlugin, HistoryParse, LaunchContext } from '../plugin';

/** 明文密钥的常见形状：启动注入里出现就算违规 */
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+\S{6,}/i,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\bnomi-(?:gw|tab)-[A-Za-z0-9_-]{6,}/,
  /\b(xai|gsk|ghp|gho|github_pat|glpat|hf)_[A-Za-z0-9_]{12,}/,
];

export interface HistoryFixture {
  /** 夹具名（报错时显示），如 `2.1.309/basic.jsonl` */
  name: string;
  text: string;
  /** 文件名（parse 可能按文件名取会话 id） */
  path?: string;
  expect: { messages?: number; title?: string; error?: boolean };
}

export interface ContractOptions {
  host?: Partial<CliMainHost>;
  /** 历史夹具：给了就要求 history.parse 存在并逐个比对 */
  historyFixtures?: HistoryFixture[];
  /** 宿主补上的能力（内置插件的转录解析在主进程，测试时一起传进来） */
  extend?: (impl: CliMainImpl) => CliMainImpl;
}

const baseHost = (o: Partial<CliMainHost> = {}): CliMainHost => ({
  logger: { info() {}, warn() {} },
  dataDir: '/tmp/nomi-contract',
  home: '/home/tester',
  env: {},
  platform: 'linux',
  ...o,
});

const ctx = (mode: HarnessPermissionMode, accountDir: string | null): LaunchContext => ({
  cwd: '/work',
  permissionMode: mode,
  model: 'model-x',
  effort: null,
  accountDir,
  runDir: '/tmp/nomi-run',
});

function secretsIn(values: string[]): string[] {
  return values.filter((v) => SECRET_SHAPES.some((re) => re.test(v)));
}

const stable = (v: unknown) => JSON.stringify(v);

function countMessages(p: HistoryParse): number | undefined {
  return 'meta' in p ? (p.messages?.length ?? 0) : undefined;
}

export async function checkPlugin(plugin: CliPlugin, o: ContractOptions = {}): Promise<string[]> {
  const problems: string[] = [];
  const m = plugin.manifest;
  for (const e of validateManifest(m)) problems.push(`manifest: ${e}`);
  if (problems.length) return problems;
  if (!plugin.main) return ['main: built-in plugins must provide a main implementation'];
  let impl: CliMainImpl;
  try {
    impl = await plugin.main(baseHost(o.host));
  } catch (e) {
    return [`main: factory threw ${(e as Error).message}`];
  }
  if (o.extend) impl = o.extend(impl);
  const caps = m.capabilities;
  const need = (cond: boolean | undefined, ok: unknown, what: string) => {
    if (cond && !ok) problems.push(`capability ${what} is declared but not implemented`);
  };
  need(caps.resume, impl.history?.roots && impl.history.resume, 'resume (history.roots/resume)');
  need(caps.officialAccount, impl.accounts, 'officialAccount (accounts)');
  need(caps.terminalCommand, impl.terminal, 'terminalCommand (terminal)');
  need(caps.progressMonitor, impl.progress, 'progressMonitor (progress)');
  need(caps.usageQuota, impl.usage, 'usageQuota (usage)');

  // 权限档位：清单与实现一致；每档的启动注入确定
  const declared = (caps.permissionModes ?? []).map((p) => p.mode);
  if (declared.length) {
    if (!impl.permissions)
      problems.push('permissionModes declared but permissions not implemented');
    else {
      const sup = [...impl.permissions.supported].sort();
      if (stable(sup) !== stable([...declared].sort()))
        problems.push(
          `permissions.supported (${sup.join(',')}) differs from manifest (${[...declared].sort().join(',')})`,
        );
      for (const mode of declared) {
        const a = impl.permissions.launch(mode);
        const b = impl.permissions.launch(mode);
        if (stable(a) !== stable(b))
          problems.push(`permissions.launch(${mode}) is not deterministic`);
        const spec = caps.permissionModes!.find((p) => p.mode === mode)!;
        if (spec.args && stable(spec.args) !== stable(a.args))
          problems.push(`permissions.launch(${mode}).args differ from manifest`);
        if (spec.modeId && impl.permissions.modeId && impl.permissions.modeId(mode) !== spec.modeId)
          problems.push(`permissions.modeId(${mode}) differs from manifest`);
      }
    }
  }

  // 启动注入：确定、不含明文密钥
  for (const accountDir of [null, '/acct/one']) {
    const mode = declared[0] ?? 'plan';
    const a = impl.launch.official(ctx(mode, accountDir));
    const b = impl.launch.official(ctx(mode, accountDir));
    if (stable(a) !== stable(b))
      problems.push(`launch.official is not deterministic (accountDir=${accountDir})`);
    const leaked = secretsIn([...a.args, ...Object.values(a.env)]);
    if (leaked.length) problems.push(`launch.official contains secret-looking values: ${leaked}`);
    if (accountDir && impl.accounts && a.env[impl.accounts.homeEnv] !== accountDir)
      problems.push(`launch.official does not point ${impl.accounts.homeEnv} at the account dir`);
  }

  // 账号目录
  if (impl.accounts) {
    const acc = impl.accounts;
    if (!acc.strip.includes(acc.homeEnv))
      problems.push(`accounts.strip must include ${acc.homeEnv} (S3)`);
    for (const s of acc.shared)
      if (s.name.startsWith('/') || s.name.split(/[\\/]/).includes('..'))
        problems.push(`accounts.shared entry ${s.name} must be a relative path inside the home`);
    if (!acc.loginArgs.length) problems.push('accounts.loginArgs is empty');
  }

  // 历史夹具
  const fixtures = o.historyFixtures ?? [];
  if (fixtures.length && !impl.history?.parse)
    problems.push('history fixtures given but history.parse is not implemented');
  else
    for (const f of fixtures) {
      let r: HistoryParse;
      try {
        r = impl.history!.parse!(f.text, {
          path: f.path ?? `/fixtures/${f.name}`,
          mtime: 0,
          size: f.text.length,
        });
      } catch (e) {
        problems.push(`history fixture ${f.name}: parse threw ${(e as Error).message}`);
        continue;
      }
      if (f.expect.error) {
        if (!('error' in r)) problems.push(`history fixture ${f.name}: expected an error`);
        continue;
      }
      if ('error' in r) {
        problems.push(`history fixture ${f.name}: ${r.error}`);
        continue;
      }
      const n = countMessages(r);
      if (f.expect.messages !== undefined && n !== f.expect.messages)
        problems.push(`history fixture ${f.name}: ${n} messages, expected ${f.expect.messages}`);
      if (f.expect.title !== undefined && r.meta.title !== f.expect.title)
        problems.push(
          `history fixture ${f.name}: title ${JSON.stringify(r.meta.title)}, expected ${JSON.stringify(f.expect.title)}`,
        );
    }
  return problems;
}
