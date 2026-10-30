'use strict';
// index.mjs 的 CommonJS 版（Jest 用），说明见那里；两份一起改。
/* eslint-disable @typescript-eslint/no-require-imports -- 本文件就是 CommonJS 入口 */
const fs = require('node:fs');
const path = require('node:path');

let cached;

function repoRoot() {
  if (cached) return cached;
  for (let d = __dirname; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) return (cached = d);
    if (path.dirname(d) === d) throw new Error('repo-paths: pnpm-workspace.yaml not found');
  }
}

function repoPath(...segments) {
  return path.join(repoRoot(), ...segments);
}

module.exports = { repoRoot, repoPath };
