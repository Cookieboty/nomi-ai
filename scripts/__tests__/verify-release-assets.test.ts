import { describe, expect, it } from 'vitest';

import { verifyReleaseAssets } from '../release/verify-release-assets.mjs';

// 回归 #146：三端清单 + 清单里列出的文件全部上传后才允许发布 draft Release
const yml = (version: string, files: string[]) =>
  [
    `version: ${version}`,
    'files:',
    ...files.flatMap((f) => [`  - url: ${f}`, '    sha512: AAAA', '    size: 1']),
    `path: ${files[0]}`,
  ].join('\n');

const full = () => ({
  assets: [
    'latest.yml',
    'latest-mac.yml',
    'latest-linux.yml',
    'Nomi-Setup-2.1.0.exe',
    'Nomi-2.1.0-mac.zip',
    'Nomi-2.1.0-arm64-mac.zip',
    'Nomi-2.1.0.dmg',
    'Nomi-2.1.0-arm64.dmg',
    'Nomi-2.1.0.AppImage',
  ],
  manifests: {
    'latest.yml': yml('2.1.0', ['Nomi-Setup-2.1.0.exe']),
    'latest-mac.yml': yml('2.1.0', [
      'Nomi-2.1.0-mac.zip',
      'Nomi-2.1.0-arm64-mac.zip',
      'Nomi-2.1.0.dmg',
      'Nomi-2.1.0-arm64.dmg',
    ]),
    'latest-linux.yml': yml('2.1.0', ['Nomi-2.1.0.AppImage']),
  } as Record<string, string>,
});

describe('verifyReleaseAssets', () => {
  it('三端齐全 → 无错误', () => {
    const { assets, manifests } = full();
    expect(verifyReleaseAssets(assets, manifests, '2.1.0').errors).toEqual([]);
  });

  it('空 Release（v2.0.3 事故现场）→ 三个清单都缺', () => {
    expect(verifyReleaseAssets([], {}, '2.0.3').errors).toEqual([
      'missing latest.yml',
      'missing latest-mac.yml',
      'missing latest-linux.yml',
    ]);
  });

  it('缺 Windows 清单 → 拦住', () => {
    const { assets, manifests } = full();
    delete manifests['latest.yml'];
    const errors = verifyReleaseAssets(
      assets.filter((a) => a !== 'latest.yml'),
      manifests,
      '2.1.0',
    ).errors;
    expect(errors).toEqual(['missing latest.yml']);
  });

  it('清单列出的安装包没上传 / 版本不符 → 拦住', () => {
    const { assets, manifests } = full();
    manifests['latest-linux.yml'] = yml('2.0.9', ['Nomi-2.1.0.AppImage']);
    const errors = verifyReleaseAssets(
      assets.filter((a) => a !== 'Nomi-2.1.0-arm64-mac.zip'),
      manifests,
      '2.1.0',
    ).errors;
    expect(errors).toContain('latest-mac.yml: listed file not uploaded: Nomi-2.1.0-arm64-mac.zip');
    expect(errors).toContain('latest-linux.yml: version 2.0.9 != 2.1.0');
  });
});
