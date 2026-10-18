/**
 * 对 Claude / Codex 配置做「只改连接字段」的补丁，并支持备份恢复。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ClaudeEnvPatch {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
}

export interface CodexPatch {
  model?: string;
  model_provider?: string;
  /** 写入 auth.json 的 OPENAI_API_KEY */
  OPENAI_API_KEY?: string;
  /** config.toml 里 providers 段用的 name */
  providerName?: string;
  base_url?: string;
  /** 默认 responses（Codex 原生） */
  wire_api?: 'responses' | 'chat';
}

export function claudeSettingsPath(home = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json');
}

export function codexConfigPath(home = os.homedir()): string {
  return path.join(home, '.codex', 'config.toml');
}

export function codexAuthPath(home = os.homedir()): string {
  return path.join(home, '.codex', 'auth.json');
}

export function ensureDir(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

export function backupFile(src: string, backupRoot: string, label: string): string | null {
  if (!fs.existsSync(src)) return null;
  const dest = path.join(backupRoot, label);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
}

/** 合并 Claude settings.json 的 env 字段；保留其余一切 */
export function patchClaudeSettings(raw: string | null, patch: ClaudeEnvPatch): string {
  let obj: Record<string, unknown> = {};
  if (raw) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      obj = {};
    }
  }
  const env =
    obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)
      ? { ...(obj.env as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') delete env[k];
    else env[k] = v;
  }
  obj.env = env;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * 极简 TOML 补丁：设置顶层 model / 并确保 [model_providers.nomi] 段。
 * 不追求完整 TOML 解析；对未知内容尽量保留原文件头部注释与其它段。
 */
export function patchCodexToml(raw: string | null, patch: CodexPatch): string {
  const lines = (raw ?? '').split(/\r?\n/);
  const out: string[] = [];
  let inProvider = false;
  /** 只改写首个表头之前的顶层键；[profiles.*] 等表里的同名键保持原样 */
  let inTable = false;
  let sawModel = false;
  let sawProviderKey = false;
  const provider = patch.providerName ?? 'nomi';
  const providerHeader = `[model_providers.${provider}]`;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      inProvider = t === providerHeader;
      inTable = true;
      // 本段在文件末尾整体重写；保留原标题会导致重复的 TOML 表（Codex 拒绝解析）
      if (!inProvider) out.push(line);
      continue;
    }
    if (!inTable && /^model\s*=/.test(t) && patch.model) {
      out.push(`model = "${escapeToml(patch.model)}"`);
      sawModel = true;
      continue;
    }
    if (!inTable && /^model_provider\s*=/.test(t) && patch.model_provider) {
      out.push(`model_provider = "${escapeToml(patch.model_provider)}"`);
      sawProviderKey = true;
      continue;
    }
    if (inProvider) {
      // 整段稍后重写，跳过旧内容
      continue;
    }
    out.push(line);
  }

  if (!sawModel && patch.model) out.unshift(`model = "${escapeToml(patch.model)}"`);
  if (!sawProviderKey && patch.model_provider)
    out.unshift(`model_provider = "${escapeToml(patch.model_provider)}"`);

  // 去掉文件末尾空行后追加 provider 段
  while (out.length && out[out.length - 1] === '') out.pop();
  out.push('');
  out.push(providerHeader);
  out.push(`name = "${escapeToml(provider)}"`);
  if (patch.base_url) out.push(`base_url = "${escapeToml(patch.base_url)}"`);
  out.push(`wire_api = "${patch.wire_api ?? 'responses'}"`);
  out.push('');
  return out.join('\n');
}

/** 移除 Nomi 写入的 Codex 供应商段与 model_provider = "nomi"，其余原样保留 */
export function unpatchCodexToml(raw: string | null, provider = 'nomi'): string {
  const header = `[model_providers.${provider}]`;
  const out: string[] = [];
  let inTable = false;
  let skipping = false;
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      inTable = true;
      skipping = t === header;
      if (skipping) continue;
    }
    if (skipping) continue;
    if (!inTable && new RegExp(`^model_provider\\s*=\\s*"${provider}"\\s*$`).test(t)) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.length ? `${out.join('\n')}\n` : '';
}

function escapeToml(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 仅当 auth.json 里的 OPENAI_API_KEY 等于 Nomi 写入的那个时才移除 */
export function unpatchCodexAuth(
  raw: string | null,
  writtenKey: string | undefined,
): string | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (writtenKey && obj.OPENAI_API_KEY === writtenKey) delete obj.OPENAI_API_KEY;
    return `${JSON.stringify(obj, null, 2)}\n`;
  } catch {
    return raw;
  }
}

export function patchCodexAuth(raw: string | null, apiKey: string | undefined): string {
  let obj: Record<string, unknown> = {};
  if (raw) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      obj = {};
    }
  }
  if (apiKey) obj.OPENAI_API_KEY = apiKey;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** dsh 家目录：DSH_HOME 或 ~/.dsh */
export function dshHomePath(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(home, '.dsh');
}

/** dsh 家目录级配置补丁（对所有 profile 生效） */
export function dshPatchPath(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dshHomePath(home, env), 'cordis.patch.yml');
}

export const DSH_MARK_BEGIN = '# >>> nomi managed (dsh provider) >>>';
export const DSH_MARK_END = '# <<< nomi managed (dsh provider) <<<';
/** 密钥不写盘：dsh 从该环境变量读取，由接管服务在启动时注入 */
export const DSH_KEY_ENV = 'NOMI_DSH_API_KEY';

export interface DshPatch {
  /** dsh 的 api 名：openai-completions / openai-responses / anthropic-messages */
  api: string;
  baseURL: string;
  model: string;
}

/** YAML 双引号标量与 JSON 字符串兼容 */
const yq = (v: string) => JSON.stringify(v);

/**
 * 在 cordis.patch.yml（顶层为插件补丁列表）里替换 / 移除 Nomi 管理的区块，
 * 其余内容原样保留。patch 为 null 时只移除区块。
 */
export function patchDshYaml(raw: string | null, patch: DshPatch | null): string {
  const lines = (raw ?? '').replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === DSH_MARK_BEGIN) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (line.trim() === DSH_MARK_END) inBlock = false;
      continue;
    }
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1]!.trim() === '') kept.pop();
  if (patch) {
    if (kept.length) kept.push('');
    kept.push(
      DSH_MARK_BEGIN,
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      nomi:',
      `        api: ${yq(patch.api)}`,
      `        baseURL: ${yq(patch.baseURL)}`,
      `        apiKeyEnv: ${DSH_KEY_ENV}`,
      '        models:',
      `          - id: ${yq(patch.model)}`,
      '- id: agent-default-model',
      '  config:',
      '    provider: nomi',
      `    model: ${yq(patch.model)}`,
      DSH_MARK_END,
    );
  }
  return kept.length ? `${kept.join('\n')}\n` : '';
}

/** Grok Build 家目录：GROK_HOME 或 ~/.grok */
export function grokHomePath(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GROK_HOME?.trim();
  if (fromEnv) {
    if (fromEnv === '~') return home;
    if (fromEnv.startsWith('~/') || fromEnv.startsWith('~\\'))
      return path.join(home, fromEnv.slice(2));
    return path.resolve(fromEnv);
  }
  return path.join(home, '.grok');
}

export function grokConfigPath(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return path.join(grokHomePath(home, env), 'config.toml');
}

export const GROK_MARK_BEGIN = '# >>> nomi managed (grok provider) >>>';
export const GROK_MARK_END = '# <<< nomi managed (grok provider) <<<';
/** 密钥不写盘：Grok 从该环境变量读取（config 里 env_key），由接管服务在启动时注入 */
export const GROK_KEY_ENV = 'NOMI_GROK_API_KEY';

export interface GrokPatch {
  /** config.toml 的 api_backend：responses | chat_completions | messages */
  apiBackend: 'responses' | 'chat_completions' | 'messages';
  baseUrl: string;
  model: string;
  /** [model.<id>] 段名，默认 nomi */
  id?: string;
}

/**
 * 在 ~/.grok/config.toml 里替换 / 移除 Nomi 管理的标记区块，并设置 [models].default = "nomi"。
 * 其余内容原样保留。patch 为 null 时只移除标记区块。
 */
export function patchGrokToml(raw: string | null, patch: GrokPatch | null): string {
  const id = patch?.id ?? 'nomi';
  const lines = (raw ?? '').replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let inMarked = false;
  let skipModel = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === GROK_MARK_BEGIN) {
      inMarked = true;
      continue;
    }
    if (t === GROK_MARK_END) {
      inMarked = false;
      continue;
    }
    if (inMarked) continue;
    if (t.startsWith('[') && t.endsWith(']')) {
      skipModel = t === `[model.${id}]`;
      if (skipModel) continue;
    } else if (skipModel) {
      continue;
    }
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  if (!patch) {
    // 兼容旧写入：标记外残留的 [models] + default = "nomi"
    const cleaned: string[] = [];
    let inModels = false;
    let modelsBuf: string[] = [];
    const flushModels = () => {
      const body = modelsBuf.filter((l) => !/^default\s*=\s*"nomi"\s*$/.test(l.trim()));
      if (body.length) {
        cleaned.push('[models]');
        cleaned.push(...body);
      }
      modelsBuf = [];
    };
    for (const line of kept) {
      const t = line.trim();
      if (t.startsWith('[') && t.endsWith(']')) {
        if (inModels) flushModels();
        inModels = t === '[models]';
        if (!inModels) cleaned.push(line);
        continue;
      }
      if (inModels) {
        if (t) modelsBuf.push(line);
        continue;
      }
      cleaned.push(line);
    }
    if (inModels) flushModels();
    while (cleaned.length && cleaned[cleaned.length - 1] === '') cleaned.pop();
    return cleaned.length ? `${cleaned.join('\n')}\n` : '';
  }
  const block = [
    '',
    GROK_MARK_BEGIN,
    `[model.${id}]`,
    `model = "${escapeToml(patch.model)}"`,
    `base_url = "${escapeToml(patch.baseUrl)}"`,
    `name = "Nomi"`,
    `env_key = "${GROK_KEY_ENV}"`,
    `api_backend = "${patch.apiBackend}"`,
    '',
    '[models]',
    `default = "${id}"`,
    GROK_MARK_END,
    '',
  ];
  return `${kept.join('\n')}${kept.length ? '\n' : ''}${block.join('\n')}`;
}
