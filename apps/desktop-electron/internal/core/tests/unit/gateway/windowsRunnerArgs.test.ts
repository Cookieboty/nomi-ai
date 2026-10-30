jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { execFile } from 'node:child_process';
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
  it('treats numbers / booleans / a single value as strings instead of crashing', async () => {
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
    // 每个用例起一个 Node 进程：并发起，不要一个个 spawnSync——全量并行时每次启动都要一两秒，
    // 串起来会撞上 10 秒的用例超时
    const go = (json: string) =>
      new Promise<string>((resolve) => {
        execFile(
          process.execPath,
          [file, cfg, '--nomi-powershell-args'],
          { env: { ...process.env, NOMI_TERMINAL_ARGS: json }, encoding: 'utf8' },
          (_err, _stdout, stderr) => resolve(stderr.trim()),
        );
      });
    const [a, b, c, model] = await Promise.all([
      // 参数解析通过后才会去连网关（这里必然连不上）→ DOWN
      go('["-p",5,true,null]'),
      go('"solo"'),
      go('[]'),
      // 数字后面跟 --nomi-model 也能被识别（模型校验失败说明走到了解析）
      go('[1,"--nomi-model","bad model"]'),
    ]);
    expect([a, b, c]).toEqual(['DOWN', 'DOWN', 'DOWN']);
    expect(model).toBe('BAD');
  });
});
