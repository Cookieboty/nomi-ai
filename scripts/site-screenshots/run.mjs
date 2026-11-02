#!/usr/bin/env node
// pnpm screenshots:site —— 官网 / README 用的应用截图，一条命令从零重拍。
//
// 真实的视图（ai-chat）跑在 pnpm dev:web 的无界面内核上，数据全是演示数据：
//   - 隔离的 HOME（临时目录）：读不到本机 ~/.claude、~/.codex 的会话历史与用量，截图里不会出现私人内容；
//   - 模拟模型（mock-llm.mjs，OpenAI 兼容）当「演示 DeepSeek」供应商；
//   - 编程助手用仓库里的 Mock CLI（NOMI_USE_MOCK_CLI=1），不调用真实的 Claude Code / Codex；
//   - 每张截图前做隐私检查：页面文字里出现本机用户名或真实 HOME 路径就中止。
//
//   pnpm build                                  # 先构建（与 dev:web 相同）
//   pnpm screenshots:site                       # 全部场景，输出到 .site-shots/
//   pnpm screenshots:site -- --only chat,tasks  # 只拍这几张
//   pnpm screenshots:site -- --out ../shots --keep   # 指定输出目录；保留临时数据目录便于排查
//   pnpm screenshots:site -- --explore          # 不拍成品：逐个设置页输出无障碍结构 + 截图，写新场景时用
//
// 输出：<out>/<name>.png（2560×1888，2 倍像素）与 <name>-640.webp / <name>.webp（1280）/ <name>-2x.webp（2560），
// 文件名与官网 assets/screenshots/ 一致，可直接拷过去。场景定义在 scenes.mjs。
/* global document, createImageBitmap, OffscreenCanvas -- page.evaluate 的回调在页面里运行 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockLlm } from './mock-llm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VIEWPORT = { width: 1280, height: 944 };
const SCALE = 2;
const WEBP = [
  { suffix: '-640', width: 640 },
  { suffix: '', width: 1280 },
  { suffix: '-2x', width: 2560 },
];

function parseArgs(argv) {
  const out = { out: path.join(ROOT, '.site-shots'), only: null, keep: false, explore: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--only') out.only = new Set(argv[++i].split(',').map((s) => s.trim()));
    else if (a === '--keep') out.keep = true;
    else if (a === '--explore') out.explore = true;
    else if (a === '--') continue;
    else throw new Error(`[site-shots] unknown argument: ${a}`);
  }
  return out;
}

/** 演示项目：编程助手会话的工作目录，一个干净的小 git 仓库 */
function makeDemoProject(home) {
  const dir = path.join(home, 'projects', 'my-app');
  fs.mkdirSync(path.join(dir, 'src', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "my-app", "version": "1.0.0" }\n');
  fs.writeFileSync(
    path.join(dir, 'src', 'cli', 'a.ts'),
    'export function registerHandler(name: string) {\n  return name;\n}\n',
  );
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  try {
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'init');
  } catch {
    // 没有 git 也能拍，只是没有分支信息
  }
  return dir;
}

/** 演示知识库：几份 Markdown，供「加入文件夹」预设的目录对话框答案用 */
function makeDemoDocs(home) {
  const dir = path.join(home, 'Documents', '产品资料');
  fs.mkdirSync(dir, { recursive: true });
  const docs = {
    '2.1 发布说明.md':
      '# Nomi 2.1\n\n- 持续任务：按时间或事件推进\n- 后台派活与素材库\n- 应用与账号\n',
    '用户访谈纪要.md': '# 用户访谈\n\n1. 希望一个地方管理所有模型\n2. 编程助手的会话要能接着聊\n',
    '竞品对比.md': '# 竞品对比\n\n| 维度 | Nomi |\n| --- | --- |\n| 本地优先 | 是 |\n',
    '会议记录 10-30.md': '# 周会\n\n- 素材库批量导出排期到下周\n',
  };
  for (const [name, body] of Object.entries(docs)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

/**
 * PATH 里在真实 HOME 下的目录（nvm、~/.local/bin……）会让设置页显示 /Users/<你>/… 路径：
 * 换成隔离 HOME 里的 bin，用符号链接指向原来的可执行文件。
 */
function isolatePath(home, realHome) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const keep = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (!dir.startsWith(realHome)) {
      keep.push(dir);
      continue;
    }
    for (const name of ['node', 'npm', 'npx', 'pnpm', 'corepack', 'git']) {
      const src = path.join(dir, name);
      const dst = path.join(bin, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
    }
  }
  process.env.PATH = [bin, ...keep].join(path.delimiter);
}

/** 演示图片：用浏览器画几张暖色海报（不引入外部素材），发到对话里进素材库 */
async function makeDemoImages(browser, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const page = await browser.newPage();
  const palettes = [
    ['#F7A46F', '#B94B2A', '#FFE7B8'],
    ['#F3D2B3', '#D88A5B', '#6B3B26'],
    ['#FFF0DF', '#F5C9A3', '#C9542A'],
    ['#2E2440', '#C2603A', '#FFD08A'],
  ];
  const files = [];
  for (const [i, [a, b, sun]] of palettes.entries()) {
    const b64 = await page.evaluate(
      async ({ a, b, sun, i }) => {
        const c = new OffscreenCanvas(900, 1200);
        const x = c.getContext('2d');
        const g = x.createLinearGradient(0, 0, 0, 1200);
        g.addColorStop(0, a);
        g.addColorStop(1, b);
        x.fillStyle = g;
        x.fillRect(0, 0, 900, 1200);
        x.fillStyle = sun;
        x.beginPath();
        x.arc(i % 2 ? 300 : 620, 380 + i * 30, 150, 0, Math.PI * 2);
        x.fill();
        x.fillStyle = 'rgba(40,24,16,0.55)';
        x.beginPath();
        x.moveTo(0, 900 - i * 20);
        x.quadraticCurveTo(450, 760, 900, 920);
        x.lineTo(900, 1200);
        x.lineTo(0, 1200);
        x.fill();
        const blob = await c.convertToBlob({ type: 'image/png' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let k = 0; k < buf.length; k += 0x8000)
          s += String.fromCharCode(...buf.subarray(k, k + 0x8000));
        return btoa(s);
      },
      { a, b, sun, i },
    );
    const file = path.join(dir, `秋日咖啡-${i + 1}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    files.push(file);
  }
  await page.close();
  return files;
}

/** 截图前的隐私检查：本机用户名 / 真实 HOME 不能出现在页面上 */
function makePrivacyGuard(realHome, realUser) {
  const needles = [realHome, `/Users/${realUser}`, `\\Users\\${realUser}`];
  if (realUser.length >= 4 && !/^(nomi|demo|user|admin|root)$/i.test(realUser))
    needles.push(realUser);
  return async (page, name) => {
    const text = await page.evaluate(() => {
      const values = [...document.querySelectorAll('input, textarea')].map((el) => el.value);
      const titles = [...document.querySelectorAll('[title]')].map((el) =>
        el.getAttribute('title'),
      );
      return [document.body.innerText, ...values, ...titles].join('\n');
    });
    const hit = needles.find((n) => n && text.toLowerCase().includes(n.toLowerCase()));
    if (hit)
      throw new Error(
        `[site-shots] ${name}: page shows local identity (${hit.slice(0, 3)}…); not saved`,
      );
  };
}

/** PNG → 三档 WebP：用 Chromium 自带的编码器，不额外引依赖 */
async function exportWebp(browser, pngPath, outDir, name, sizes = WEBP) {
  const page = await browser.newPage();
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(pngPath).toString('base64');
  for (const { suffix, width } of sizes) {
    const b64 = await page.evaluate(
      async ({ src, width }) => {
        const img = await createImageBitmap(await (await fetch(src)).blob());
        const height = Math.round((img.height * width) / img.width);
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000)
          s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(s);
      },
      { src: dataUrl, width },
    );
    fs.writeFileSync(path.join(outDir, `${name}${suffix}.webp`), Buffer.from(b64, 'base64'));
  }
  await page.close();
}

/** 桌面角色：renderer 页面透明背景，按官网 mascot-330 / mascot（660）/ mascot-2x（1320）导出 */
async function shootMascot(browser, url, outDir, name, guard) {
  const ctx = await browser.newContext({
    viewport: { width: 330, height: 355 },
    deviceScaleFactor: 4,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url);
    await page.waitForTimeout(6000);
    await guard(page, name);
    const png = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: png, omitBackground: true });
    await exportWebp(browser, png, outDir, name, [
      { suffix: '-330', width: 330 },
      { suffix: '', width: 660 },
      { suffix: '-2x', width: 1320 },
    ]);
  } finally {
    await ctx.close();
  }
}

const out = (line) => process.stdout.write(`${line}\n`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const realHome = os.homedir();
  const realUser = os.userInfo().username;

  // 浏览器先起：Playwright 按 HOME 找已下载的浏览器，改 HOME 之前启动
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();

  // 1) 隔离环境：必须在任何模块读 os.homedir() 之前改 HOME
  // 设置页会显示 Node / CLI 的完整路径：工作目录放在短路径下，截图里好看一些
  const tmpBase = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const work = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'nomi-')));
  const home = path.join(work, 'home');
  fs.mkdirSync(home, { recursive: true });
  const project = makeDemoProject(home);
  const docsDir = makeDemoDocs(home);
  const images = await makeDemoImages(browser, path.join(home, 'Pictures'));
  isolatePath(home, realHome);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const k of [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'GEMINI_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ])
    delete process.env[k];
  // Mock CLI 拷进隔离 HOME：设置页会显示 CLI 路径，不能是仓库所在的 /Users/<你>/…
  const mockSrc = path.join(ROOT, 'apps/desktop-electron/internal/core/scripts/mock-cli');
  const mockDir = path.join(home, '.local', 'share', 'nomi-mock-cli');
  fs.cpSync(mockSrc, mockDir, { recursive: true });
  Object.assign(process.env, {
    NOMI_MOCK_CLI_DIR: mockDir,
    NOMI_USE_MOCK_CLI: '1',
    NOMI_MOCK_TOOLS: 'rich',
    NOMI_MOCK_STEP_MS: '120',
    NOMI_MOCK_CLAUDE_REPLY:
      '已把 registerHandler 改成接收可选的 id 参数，补上了 2 个单测，lint 也通过了。',
  });

  const llm = await startMockLlm();
  const { freePort, startDevWeb } = await import('../dev-web/start.mjs');
  const dev = await startDevWeb({
    dataDir: path.join(work, 'data'),
    chatPort: await freePort(),
    mascotPort: await freePort(),
    viteStdio: 'ignore',
    logLevel: 'warn',
    ports: {
      // 设置页显示的版本号用仓库版本，不是开发态的 0.0.0
      app: {
        name: 'Nomi',
        version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
        locale: 'zh-CN',
      },
      // 系统对话框的预设答案：知识库「加入文件夹」选演示文档；附件选演示图片
      dialogs: { pickDirectory: Array(8).fill(docsDir), pickFiles: Array(8).fill(images) },
    },
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    locale: 'zh-CN',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const guard = makePrivacyGuard(realHome, realUser);
  fs.mkdirSync(args.out, { recursive: true });

  const { createHelpers, SCENES, explore } = await import('./scenes.mjs');
  const h = createHelpers(page, {
    chatPageUrl: dev.chatPageUrl,
    llmBaseUrl: llm.baseUrl,
    project,
    docsDir,
    images,
    dataDir: path.join(work, 'data'),
  });

  const failures = [];
  try {
    if (args.explore) {
      await explore(page, h, args.out);
    } else {
      for (const scene of SCENES) {
        const wanted = !args.only || args.only.has(scene.name);
        // 准备步骤（seed）总要跑，后面的场景依赖它造好的数据
        if (!wanted && !scene.seed) continue;
        process.stdout.write(`[site-shots] ${scene.name}… `);
        try {
          if (scene.mascot) {
            await shootMascot(browser, dev.mascotPageUrl, args.out, scene.name, guard);
            process.stdout.write('ok\n');
            continue;
          }
          await scene.run(h);
          if (scene.seed) {
            process.stdout.write('seeded\n');
            continue;
          }
          await page.mouse.move(2, VIEWPORT.height - 2);
          await page.waitForTimeout(400);
          await guard(page, scene.name);
          const png = path.join(args.out, `${scene.name}.png`);
          await page.screenshot({ path: png, ...(scene.shot ?? {}) });
          await exportWebp(browser, png, args.out, scene.name);
          process.stdout.write('ok\n');
        } catch (e) {
          failures.push(scene.name);
          process.stdout.write(`FAILED\n  ${String(e.message).split('\n')[0]}\n`);
          await page
            .screenshot({ path: path.join(args.out, `_failed-${scene.name}.png`) })
            .catch(() => {});
          await h.open().catch(() => {});
        }
      }
    }
  } finally {
    await browser.close();
    await dev.stop();
    await llm.close();
    if (args.keep) out(`[site-shots] kept work dir: ${work}`);
    else fs.rmSync(work, { recursive: true, force: true });
  }
  if (pageErrors.length) out(`[site-shots] page errors: ${pageErrors.slice(0, 5).join(' | ')}`);
  out(`[site-shots] output: ${args.out}`);
  if (failures.length) {
    out(`[site-shots] failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
