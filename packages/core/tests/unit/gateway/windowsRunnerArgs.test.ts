jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import { buildWindowsRunner } from '../../../src/gateway/windowsTerminal';

// 运行器是纯 Node 脚本，任何平台都能跑到「找不到 CLI」这一步，用来检查参数解析。
// ts-jest 产物可能带测试专用的辅助函数，这里按发布构建（tsc）的方式转译一遍再执行。
function runner(dir: string): string {
  const out = ts.transpileModule(buildWindowsRunner(), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const file = path.join(dir, 'nomi-runner.cjs');
  fs.writeFileSync(file, out);
  return file;
}

describe('Windows runner argv from PowerShell', () => {
  it('treats numbers / booleans / a single value as strings instead of crashing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-runner-'));
    const cfg = path.join(dir, 'cfg.json');
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        kind: 'claude',
        model: 'relay/default',
        url: 'http://127.0.0.1:9',
        tokenFile: path.join(dir, 'missing'),
        launch: { env: {}, args: [], strip: [] },
        messages: { down: 'DOWN', badModel: 'BAD', needModel: 'NEED', noModel: 'NOMODEL' },
      }),
    );
    const file = runner(dir);
    const go = (json: string) =>
      spawnSync(process.execPath, [file, cfg, '--nomi-powershell-args'], {
        env: { ...process.env, NOMI_TERMINAL_ARGS: json },
        encoding: 'utf8',
      });
    // 参数解析通过后才会去连网关（这里必然连不上）→ DOWN
    for (const json of ['["-p",5,true,null]', '"solo"', '[]']) {
      const r = go(json);
      expect(r.stderr.trim()).toBe('DOWN');
    }
    // 数字后面跟 --nomi-model 也能被识别（模型校验失败说明走到了解析）
    expect(go('[1,"--nomi-model","bad model"]').stderr.trim()).toBe('BAD');
  });
});
