// @vitest-environment happy-dom
/**
 * 构建期自定义角色（Scheme A，`CHARACTER_PACK=<dir> pnpm build`）在默认渲染器 `svg` 下的立绘（issue #193）：
 * 静态立绘只来自构建时选中的包，不能换成官方包的立绘。
 *
 * 这里把 `virtual:character-pack` 与 `virtual:character-static-art` 换成构建插件
 * （scripts/character/vite-plugin.mjs 的 `packModuleData` / `staticArtModule`）对另一个包的真实输出：
 * - 替身包 characters/test-dummy（static 模式，自己的 static/character.webp）；
 * - 以替身包为底的自定义 Rive 包（没有静态立绘）：按包自己的模式（rive）渲染。
 * 宿主走契约传输（真实宿主的形状）：`character.getActivePack` 报内置包（source=builtin → 没有覆盖包），
 * `mascot.getRenderer` 为 svg。官方包本身、覆盖包与 renderer=rive 在 nomi2dCanvas.test.tsx。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AvatarRuntimeOptions } from '@nomi-ai/avatar-runtime';
import { repoPath } from '@nomi-ai/repo-paths';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installMascotHost, packSnapshot, resetMascotHost } from './mascotHost';

vi.mock('../../src/services/api', async () => (await import('./mascotHost')).mascotApiModule());

const h = vi.hoisted(() => ({
  last: null as AvatarRuntimeOptions | null,
  /** 当前测试用的包：插件输出（vi.resetModules 后 mock 工厂重新读取） */
  pack: null as Record<string, unknown> | null,
  staticArt: null as string | null,
}));

// getter：mock 工厂的结果会被缓存，被测模块重新加载时读到的是当前测试的包
vi.mock('virtual:character-pack', () => ({
  get default() {
    return h.pack;
  },
}));
vi.mock('virtual:character-static-art', () => ({
  get default() {
    return h.staticArt;
  },
}));

vi.mock('@nomi-ai/avatar-runtime', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  AvatarStage: (props: AvatarRuntimeOptions) => {
    h.last = props;
    return <div data-testid="avatar-stage" data-mode={props.character.mode} />;
  },
}));

type Plugin = {
  packModuleData: (pack: unknown) => Record<string, unknown>;
  staticArtModule: (dir: string, pack: unknown) => string;
};
type Contract = {
  validatePackDirSync: (dir: string) => { pack: unknown; errors: unknown[] };
};

const tmp: string[] = [];

/** 构建插件对 `dir` 这个包的输出（与 vite 构建注入的完全相同） */
async function buildOutputs(dir: string): Promise<void> {
  const plugin = (await import(
    pathToFileURL(repoPath('scripts/character/vite-plugin.mjs')).href
  )) as Plugin;
  const { validatePackDirSync } = (await import('@nomi-ai/character-contract/node')) as Contract;
  const { pack, errors } = validatePackDirSync(dir);
  if (!pack) throw new Error(`pack does not validate: ${JSON.stringify(errors)}`);
  h.pack = plugin.packModuleData(pack);
  const code = plugin.staticArtModule(dir, pack);
  h.staticArt = (
    (await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(code)}`)) as {
      default: string | null;
    }
  ).default;
}

/** 以替身包为底、换成 Rive 模式的自定义包（没有静态立绘） */
function customRivePack(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'custom-rive-'));
  tmp.push(dir);
  cpSync(repoPath('characters/test-dummy'), dir, { recursive: true });
  rmSync(path.join(dir, 'static'), { recursive: true, force: true });
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
    id: string;
    assets: Record<string, unknown>;
  };
  manifest.id = 'custom-rive';
  manifest.assets = { mode: 'rive', rive: 'rive/character.riv', onboarding: 'onboarding' };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // 校验只看 .riv 存在且不太小；Nomi2DCanvas 不解析它
  mkdirSync(path.join(dir, 'rive'));
  writeFileSync(path.join(dir, 'rive', 'character.riv'), Buffer.alloc(4096, 1));
  return dir;
}

async function mountCanvas(renderer: 'svg' | 'rive') {
  installMascotHost({
    'mascot.getRenderer': () => renderer,
    'character.getActivePack': () =>
      packSnapshot({ source: 'builtin', id: h.pack!.id, mode: h.pack!.mode }),
  });
  vi.resetModules();
  const { Nomi2DCanvas } = await import('../../src/components/Mascot/Nomi2DCanvas');
  const { resetCharacterPackOverlayForTest } = await import('../../src/mascot/characterConfig');
  resetCharacterPackOverlayForTest();
  render(<Nomi2DCanvas manifestPath="./character/sprite/manifest.json" />);
  await screen.findByTestId('avatar-stage');
  const p = h.last!;
  const url = (v: string | null | undefined) =>
    !v ? '' : /^(?:[a-z][a-z0-9+.-]*:|\.{0,2}\/)/i.test(v) ? v : p.resolveAsset(v);
  return { p, url };
}

beforeEach(() => {
  h.last = null;
});

afterEach(() => {
  cleanup();
  resetMascotHost();
});

afterAll(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('build-time custom pack (Scheme A) on the default svg renderer', () => {
  it('test-dummy: AvatarStage gets test-dummy’s own static image, not the official art', async () => {
    await buildOutputs(repoPath('characters/test-dummy'));
    expect(h.staticArt).toBe('./character/static/character.webp');

    const { p, url } = await mountCanvas('svg');
    expect(p.character.id).toBe('test-dummy');
    expect(p.character.mode).toBe('static');
    expect(url(p.character.assets.static)).toBe('./character/static/character.webp');
    expect(url(p.character.assets.static)).not.toMatch(/\.svg/);
  });

  it('test-dummy on renderer rive: still its own static image (the pack is static)', async () => {
    await buildOutputs(repoPath('characters/test-dummy'));
    const { p, url } = await mountCanvas('rive');
    expect(p.character.mode).toBe('static');
    expect(url(p.character.assets.static)).toBe('./character/static/character.webp');
  });

  it('a custom Rive pack without static art keeps its own mode and .riv', async () => {
    await buildOutputs(customRivePack());
    expect(h.staticArt).toBeNull();

    const { p, url } = await mountCanvas('svg');
    expect(p.character.id).toBe('custom-rive');
    expect(p.character.mode).toBe('rive');
    expect(url(p.character.assets.rive)).toBe('./character/rive/character.riv');
    expect(p.character.assets.static).toBeNull();
  });
});
