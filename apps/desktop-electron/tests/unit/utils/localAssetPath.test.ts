/**
 * localAssetPath 单元测试：未打包环境下 renderer 资源路径解析
 */

// tests/setup.ts 全局 mock 了 path（join 仅做字符串拼接），这里需要真实的路径归一化
jest.unmock('path');

import * as path from 'path';

import {
  getUnpackagedAssetCandidates,
  normalizeRendererRelativePath,
  resolveUnpackagedAssetPath,
} from '../../../src/utils/localAssetPath';

const appPath = path.join('/repo', 'apps', 'desktop-electron');

describe('normalizeRendererRelativePath', () => {
  it('去掉 ./ 与 / 前缀', () => {
    expect(normalizeRendererRelativePath('./assets/mascot.min.js')).toBe('assets/mascot.min.js');
    expect(normalizeRendererRelativePath('/assets/mascot.min.js')).toBe('assets/mascot.min.js');
    expect(normalizeRendererRelativePath('.//assets/a.json')).toBe('assets/a.json');
  });

  it('去掉查询串与片段', () => {
    expect(normalizeRendererRelativePath('./assets/models/k/model.moc?v=20181102')).toBe(
      'assets/models/k/model.moc',
    );
    expect(normalizeRendererRelativePath('assets/a.json#x')).toBe('assets/a.json');
  });
});

describe('getUnpackagedAssetCandidates', () => {
  it('不再拼出 apps/desktop-electron/packages/renderer 这种错误路径', () => {
    const candidates = getUnpackagedAssetCandidates(appPath, './assets/costume_model_list.json');
    expect(candidates).toEqual([
      path.join(appPath, 'assets', 'costume_model_list.json'),
      path.join(appPath, 'dist', 'renderer', 'assets', 'costume_model_list.json'),
      path.join('/repo', 'packages', 'renderer', 'dist', 'assets', 'costume_model_list.json'),
      path.join('/repo', 'packages', 'renderer', 'public', 'assets', 'costume_model_list.json'),
    ]);
    for (const c of candidates) {
      expect(c).not.toContain(path.join('electron', 'packages'));
    }
  });
});

describe('resolveUnpackagedAssetPath', () => {
  it('返回第一个存在的候选', () => {
    const existing = path.join(
      '/repo',
      'packages',
      'renderer',
      'public',
      'assets',
      'mascot.min.js',
    );
    const resolved = resolveUnpackagedAssetPath(
      appPath,
      './assets/mascot.min.js',
      (p) => p === existing,
    );
    expect(resolved).toBe(existing);
  });

  it('优先使用 dist/renderer（copy-renderer 产物）', () => {
    const resolved = resolveUnpackagedAssetPath(appPath, './assets/a.json', () => true);
    expect(resolved).toBe(path.join(appPath, 'assets', 'a.json'));
    const resolved2 = resolveUnpackagedAssetPath(appPath, './assets/a.json', (p) =>
      p.includes(path.join('dist', 'renderer')),
    );
    expect(resolved2).toBe(path.join(appPath, 'dist', 'renderer', 'assets', 'a.json'));
  });

  it('都不存在时返回第一个候选', () => {
    expect(resolveUnpackagedAssetPath(appPath, 'x.json', () => false)).toBe(
      path.join(appPath, 'x.json'),
    );
  });
});
