/**
 * 内核的依赖方向（docs/design/core-host-decoupling.md §3.2、§11.1）：package.json 里不出现 electron、
 * Electron 专用的包、宿主包、视图包与 ui。源码 import 由 eslint（eslint.config.mjs 的 packages/core 规则）拦。
 */
jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const FORBIDDEN = [
  /^electron$/,
  /^electron-/,
  /^@electron\//,
  /^@nomi-ai\/(electron|host-electron|bundle-ig-electron-caps)$/,
  /^@nomi-ai\/(ui|ai-chat|renderer|ai-sdk-client|voice|avatar-runtime)$/,
];

describe('@nomi-ai/core package.json', () => {
  it('不依赖 electron、宿主包与视图包', () => {
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ];
    expect(names.filter((n) => FORBIDDEN.some((re) => re.test(n)))).toEqual([]);
    expect(names).toContain('@nomi-ai/host-ports');
  });
});
