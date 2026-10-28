/**
 * Node 专用入口：从目录读取角色包并校验。核心入口（`.`）不依赖 fs，浏览器也能用。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { PACK_FILES } from './contract';
import { normalizePackPath } from './paths';
import {
  validatePack,
  type PackSource,
  type ValidatePackOptions,
  type ValidatePackResult,
} from './validate';

/** 预读这些文件的内容；其余文件只记录存在与大小。 */
function shouldPreload(rel: string): boolean {
  return rel.endsWith('.json') || rel === PACK_FILES.legacySystemPrompt;
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, base: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.DS_Store') continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) await visit(join(dir, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  await visit(root, '');
  return out.sort();
}

function walkSync(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, base: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.DS_Store') continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) visit(join(dir, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  visit(root, '');
  return out.sort();
}

function sourceFrom(
  files: string[],
  texts: Map<string, string>,
  sizes: Map<string, number>,
): PackSource {
  const key = (p: string): string | null => normalizePackPath(p.split(sep).join('/'));
  return {
    files,
    readJson(path) {
      const k = key(path);
      const text = k ? texts.get(k) : undefined;
      if (text === undefined) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        throw new Error(`${k}: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
    },
    readText(path) {
      const k = key(path);
      return k ? texts.get(k) : undefined;
    },
    sizeOf(path) {
      const k = key(path);
      return k ? sizes.get(k) : undefined;
    },
  };
}

function missingDirResult(err: unknown): ValidatePackResult {
  return {
    ok: false,
    errors: [
      {
        severity: 'error',
        code: 'manifest-missing',
        file: PACK_FILES.manifest,
        path: [],
        message: err instanceof Error ? err.message : String(err),
      },
    ],
    warnings: [],
    pack: null,
  };
}

/**
 * `readPackDir` 的同步版本（主进程启动时的包解析用）。目录不存在时抛错。
 */
export function readPackDirSync(dir: string): PackSource {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`character pack directory not found: ${dir}`);
  }
  const files = walkSync(dir);
  const texts = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const rel of files) {
    const abs = join(dir, ...rel.split('/'));
    sizes.set(rel, statSync(abs).size);
    if (shouldPreload(rel)) texts.set(rel, readFileSync(abs, 'utf8'));
  }
  return sourceFrom(files, texts, sizes);
}

/** `validatePackDir` 的同步版本。 */
export function validatePackDirSync(
  dir: string,
  opts: ValidatePackOptions = {},
): ValidatePackResult {
  let source: PackSource;
  try {
    source = readPackDirSync(dir);
  } catch (err) {
    return missingDirResult(err);
  }
  return validatePack(source, opts);
}

/**
 * 读取目录形式的角色包，返回可交给 `validatePack()` 的 PackSource。
 * JSON 与人设文本预读进内存（读 JSON 失败时在 `readJson` 调用处抛错），二进制资源只记录大小。
 */
export async function readPackDir(dir: string): Promise<PackSource> {
  if (!existsSync(dir) || !(await stat(dir)).isDirectory()) {
    throw new Error(`character pack directory not found: ${dir}`);
  }
  const files = await walk(dir);
  const texts = new Map<string, string>();
  const sizes = new Map<string, number>();
  await Promise.all(
    files.map(async (rel) => {
      const abs = join(dir, ...rel.split('/'));
      sizes.set(rel, (await stat(abs)).size);
      if (shouldPreload(rel)) texts.set(rel, await readFile(abs, 'utf8'));
    }),
  );
  return sourceFrom(files, texts, sizes);
}

/** 读取并校验目录形式的角色包。目录不存在时返回带 `manifest-missing` 错误的结果。 */
export async function validatePackDir(
  dir: string,
  opts: ValidatePackOptions = {},
): Promise<ValidatePackResult> {
  let source: PackSource;
  try {
    source = await readPackDir(dir);
  } catch (err) {
    return missingDirResult(err);
  }
  return validatePack(source, opts);
}

export * from './index';
