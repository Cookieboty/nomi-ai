// 官网截图的场景。按顺序执行：seed 场景只造数据不出图（--only 时也照跑），其余每个场景结束时的画面就是一张图。
// 选择器一律用无障碍名称（getByRole），界面文案改了这里跟着改；pnpm screenshots:site -- --explore 可以查当前结构。
/* global document, DataTransfer, DragEvent -- page.evaluate 的回调在页面里运行 */
import fs from 'node:fs';
import path from 'node:path';

const out = (line) => process.stdout.write(`${line}\n`);

export function createHelpers(page, { chatPageUrl, llmBaseUrl, project, images = [], dataDir }) {
  const h = {
    page,
    project,
    wait: (ms) => page.waitForTimeout(ms),
    /** 重新打开对话窗口（内核状态保留） */
    async open() {
      await page.goto(chatPageUrl);
      // 视图会恢复上次停留的页面（设置 / 任务 / 素材库），先回到对话
      const back = page.getByRole('button', { name: '返回对话' });
      const ready = page
        .getByRole('textbox', { name: '消息输入框' })
        .or(page.getByRole('button', { name: '跳过引导' }))
        .or(back);
      await ready.first().waitFor({ timeout: 30_000 });
      // 刷新后可能还恢复着上次的弹窗（如新建任务的草稿）：先关掉
      for (
        let i = 0;
        i < 3 &&
        (await page
          .getByRole('dialog')
          .first()
          .isVisible()
          .catch(() => false));
        i++
      ) {
        await page.keyboard.press('Escape');
        await h.wait(300);
      }
      if (await back.isVisible().catch(() => false)) {
        await back.click();
        await page.getByRole('textbox', { name: '消息输入框' }).waitFor({ timeout: 15_000 });
      }
      await h.wait(800);
    },
    async mode(name) {
      await page.getByRole('group', { name: '对话模式' }).getByRole('button', { name }).click();
      await h.wait(600);
    },
    async send(text, settleMs = 3500) {
      const box = page.getByRole('textbox', { name: '消息输入框' });
      await box.click();
      await box.fill(text);
      await page.keyboard.press('Enter');
      await h.wait(settleMs);
    },
    async newChat(endpoint) {
      // 页面上可能有不止一个「新对话」按钮：点第一个
      await page.getByRole('button', { name: '新对话' }).first().click();
      const item = page.getByRole('menuitem', { name: endpoint });
      if (await item.isVisible().catch(() => false)) await item.click();
      await h.wait(900);
    },
    /** 打开设置里的某一栏，如「模型与供应商」 */
    async settings(section) {
      const back = page.getByRole('button', { name: '返回对话' });
      if (!(await back.isVisible().catch(() => false))) {
        await page
          .getByRole('navigation', { name: '应用入口' })
          .getByRole('button', { name: '设置' })
          .click();
        await h.wait(900);
      }
      if (section) {
        await page.getByRole('button', { name: section, exact: true }).first().click();
        await h.wait(1000);
      }
    },
    async tab(name) {
      await page.getByRole('tab', { name, exact: true }).first().click();
      await h.wait(900);
    },
    /** 把某个标题滚到视图上部（设置页长，截中段时用） */
    async scrollTo(heading) {
      await page
        .getByRole('heading', { name: heading })
        .first()
        .evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await h.wait(500);
    },
    /** 工作台里打开已有的编程助手会话 */
    async openSession(label = /Claude Code/) {
      await h.mode('工作台');
      await page
        .getByRole('navigation', { name: '历史对话' })
        .getByRole('button', { name: label })
        .first()
        .click();
      await h.wait(1500);
    },
    /** 模拟把演示图片拖进对话窗口（浏览器里没有 preload，走页面自己的拖放处理） */
    async dropImages(files = images) {
      const payload = files.map((f) => ({
        name: path.basename(f),
        b64: fs.readFileSync(f).toString('base64'),
      }));
      await page.evaluate((items) => {
        const dt = new DataTransfer();
        for (const { name, b64 } of items) {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          dt.items.add(new File([bin], name, { type: 'image/png' }));
        }
        const target = document.querySelector('textarea') ?? document.body;
        for (const type of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
          );
        }
      }, payload);
      await h.wait(1500);
    },
    /**
     * 浏览器里没有 Electron 的 chat-asset:// 协议（素材库缩略图用它）：从数据目录读出文件，换成 data URL。
     * 只影响截图时的页面，不改数据。
     */
    async inlineChatAssets() {
      const srcs = await page.evaluate(() => [
        ...new Set(
          [...document.images]
            .map((i) => i.getAttribute('src'))
            .filter((s) => s?.startsWith('chat-asset://')),
        ),
      ]);
      const index = new Map();
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else index.set(e.name, full);
        }
      };
      if (dataDir && fs.existsSync(dataDir)) walk(dataDir);
      const map = {};
      for (const src of srcs) {
        const file = index.get(path.basename(new URL(src).pathname));
        if (!file) continue;
        const ext = path.extname(file).slice(1).replace('jpg', 'jpeg');
        map[src] = `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`;
      }
      await page.evaluate((m) => {
        for (const img of document.images) {
          const s = img.getAttribute('src');
          if (m[s]) img.src = m[s];
        }
      }, map);
      await h.wait(600);
    },
    async createTask({ title, goal }) {
      await page.getByRole('button', { name: '新建任务' }).click();
      const dlg = page.getByRole('dialog', { name: '新建任务' });
      await dlg.getByRole('textbox', { name: '标题' }).fill(title);
      await dlg.getByRole('textbox', { name: '任务目标' }).fill(goal);
      await dlg.getByRole('button', { name: '创建' }).click();
      await dlg.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
      // 创建后可能弹授权确认卡片
      await page
        .getByRole('button', { name: /^(授权|确认|允许)/ })
        .first()
        .click({ timeout: 2500 })
        .catch(() => {});
      await h.wait(800);
    },
    async addDemoProvider() {
      await h.settings('模型与供应商');
      // 「添加第三方供应商」第一步是分组卡片（不是单选按钮）
      await page.getByTestId('models-preset-custom').click();
      await page.getByRole('textbox', { name: '地址' }).fill(llmBaseUrl);
      await page.getByRole('textbox', { name: '名称（可选）' }).fill('演示 DeepSeek');
      await page.getByRole('textbox', { name: 'API Key' }).fill('sk-demo-0000000000000000a1f3');
      await page.getByRole('button', { name: '检测并保存' }).click();
      // 本机地址要先确认一次
      await page
        .getByRole('button', { name: '确定' })
        .click({ timeout: 10_000 })
        .catch(() => {});
      await page
        .getByRole('combobox', { name: 'Nomi 对话的模型' })
        .filter({ hasText: 'deepseek' })
        .waitFor({ timeout: 20_000 });
    },
  };
  return h;
}

/**
 * name 与官网 assets/screenshots/ 的文件名一致（导出后直接覆盖）。
 * seed：只造数据不出图；mascot：拍桌面角色页面（透明背景），由 run.mjs 单独处理。
 * @type {{ name: string, title?: string, seed?: boolean, mascot?: boolean, run: (h: ReturnType<typeof createHelpers>) => Promise<void>, shot?: object }[]}
 */
export const SCENES = [
  {
    name: 'onboarding',
    title: '首次引导',
    async run(h) {
      await h.open();
      await h.page.getByRole('button', { name: '跳过引导' }).waitFor({ timeout: 15_000 });
    },
  },
  {
    name: 'seed-skip-onboarding',
    seed: true,
    async run(h) {
      await h.open();
      const skip = h.page.getByRole('button', { name: '跳过引导' });
      if (await skip.isVisible().catch(() => false)) await skip.click();
      await h.page
        .getByRole('button', { name: '隐藏' })
        .click({ timeout: 3000 })
        .catch(() => {});
    },
  },
  {
    name: 'seed-provider',
    seed: true,
    async run(h) {
      await h.open();
      await h.addDemoProvider();
    },
  },
  {
    name: 'seed-knowledge',
    seed: true,
    async run(h) {
      await h.open();
      await h.settings('知识与记忆');
      // 目录对话框的答案由 run.mjs 预设为演示文档文件夹
      await h.page
        .getByRole('button', { name: /加入文件夹/ })
        .first()
        .click();
      await h.page
        .getByText('索引完成')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => {});
    },
  },
  {
    name: 'seed-tasks',
    seed: true,
    async run(h) {
      await h.open();
      await h.mode('助手');
      await h.page.getByRole('button', { name: '任务', exact: true }).first().click();
      await h.wait(800);
      await h.createTask({
        title: '汇总 GitHub 通知',
        goal: '每天早上看一下仓库的通知和 PR，需要我处理的单独列出来',
      });
      await h.createTask({
        title: '新发票自动归档',
        goal: '下载文件夹里出现新发票时，按月份归到「财务/发票」',
      });
      await h.createTask({ title: '周五写周报', goal: '每周五下午汇总本周完成的事，生成周报草稿' });
    },
  },
  {
    name: 'seed-conversations',
    seed: true,
    async run(h) {
      await h.open();
      await h.mode('助手');
      await h.send('帮我写一份本周周报');
      await h.newChat('Nomi');
      await h.dropImages();
      await h.send('照这几张图的感觉，画一组秋天的咖啡海报');
    },
  },
  {
    name: 'chat',
    title: '助手模式对话',
    async run(h) {
      await h.open();
      await h.mode('助手');
      await h.newChat('Nomi');
      await h.send('帮我整理一下今天的待办吧');
    },
  },
  {
    name: 'coding-agent',
    title: '工作台：编程助手会话',
    async run(h) {
      await h.open();
      await h.mode('工作台');
      await h.page
        .getByRole('button', { name: '隐藏' })
        .click({ timeout: 2000 })
        .catch(() => {});
      await h.newChat('Claude Code');
      await h.send('给 registerHandler 加一个可选的 id 参数，补上单测并跑一下 lint', 9000);
    },
  },
  {
    name: 'permission-modes',
    title: '编程助手的权限模式',
    async run(h) {
      await h.open();
      await h.openSession();
      await h.page.getByRole('button', { name: /权限模式/ }).click();
      await h.wait(700);
    },
  },
  {
    name: 'workspace',
    title: '变更栏：审查改动',
    async run(h) {
      await h.open();
      await h.openSession();
      await h.page.getByRole('button', { name: '展开变更栏' }).click();
      await h.wait(1200);
    },
  },
  {
    name: 'tasks',
    title: '持续任务',
    async run(h) {
      await h.open();
      await h.mode('助手');
      await h.page.getByRole('button', { name: '任务', exact: true }).first().click();
      await h.wait(1200);
    },
  },
  {
    name: 'assets',
    title: '素材库',
    async run(h) {
      await h.open();
      await h.mode('助手');
      await h.page.getByRole('button', { name: '素材库', exact: true }).first().click();
      await h.wait(1500);
      await h.inlineChatAssets();
    },
  },
  {
    name: 'models-gateway',
    title: '模型与供应商',
    async run(h) {
      await h.open();
      await h.settings('模型与供应商');
    },
  },
  {
    name: 'settings-providers',
    title: '编辑第三方供应商',
    async run(h) {
      await h.open();
      await h.settings('模型与供应商');
      // 点供应商这一行打开编辑（行尾的「⋯」已去掉，换成启用开关）
      await h.page.getByRole('button', { name: /^演示 DeepSeek/ }).click();
      await h.wait(1000);
    },
  },
  {
    name: 'quality-panel',
    title: '用量与分析：对比',
    async run(h) {
      await h.open();
      await h.settings('用量与分析');
      await h.tab('对比');
    },
  },
  {
    name: 'external-cli',
    title: '编程助手设置',
    async run(h) {
      await h.open();
      await h.settings('编程助手');
    },
  },
  {
    name: 'delegate-settings',
    title: 'Nomi：委派',
    async run(h) {
      await h.open();
      await h.settings('Nomi');
      await h.tab('委派');
    },
  },
  {
    name: 'tools',
    title: 'Nomi：桌面权限',
    async run(h) {
      await h.open();
      await h.settings('Nomi');
      await h.tab('桌面权限');
    },
  },
  {
    name: 'knowledge',
    title: '知识与记忆',
    async run(h) {
      await h.open();
      await h.settings('知识与记忆');
    },
  },
  {
    name: 'mcp',
    title: '扩展：MCP 与技能',
    async run(h) {
      await h.open();
      await h.settings('扩展 / MCP');
    },
  },
  {
    name: 'apps-accounts',
    title: '应用与账号',
    async run(h) {
      await h.open();
      await h.settings('应用与账号');
    },
  },
  {
    name: 'auto-update',
    title: '通用：版本与外观',
    async run(h) {
      await h.open();
      await h.settings('通用');
    },
  },
  {
    name: 'i18n-language',
    title: '通用：语言与启动',
    async run(h) {
      await h.open();
      await h.settings('通用');
      await h.scrollTo(/启动与窗口/);
    },
  },
  {
    name: 'mascot',
    title: '桌面角色（透明背景）',
    mascot: true,
    async run() {},
  },
];

/** --explore：逐个设置栏 / 入口页输出无障碍结构与截图，写新场景时对照 */
export async function explore(page, h, outDir, guard) {
  const dir = path.join(outDir, 'explore');
  fs.mkdirSync(dir, { recursive: true });
  /** 先过隐私检查（页面 + 无障碍文本），全部通过才写图片与文本 */
  const dump = async (name) => {
    await guard(page, name);
    const snap = await page
      .locator('body')
      .ariaSnapshot()
      .catch((e) => String(e));
    guard.text(snap, name);
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
    fs.writeFileSync(path.join(dir, `${name}.txt`), snap);
    out(`[explore] ${name}`);
  };
  const safeDump = (name) =>
    dump(name).catch((e) =>
      out(`[explore] ${name} not saved: ${String(e.message).split('\n')[0]}`),
    );
  for (const s of SCENES.filter((x) => x.seed)) await s.run(h);
  await h.open();
  await h.settings(null);
  /** 设置左栏（与 ai-chat 设置导航一致）；新增栏目时加在这里 */
  const sections = [
    '通用',
    'Nomi',
    '模型与供应商',
    '用量与分析',
    '编程助手',
    '知识与记忆',
    '扩展 / MCP',
    '应用与账号',
    '隐私与权限',
  ];
  for (const label of sections) {
    await h.settings(label).catch(() => {});
    await safeDump(`settings-${label.replace(/[\s/·]+/g, '_')}`);
  }
  for (const entry of ['任务', '素材库']) {
    await h.open();
    await page
      .getByRole('button', { name: entry, exact: true })
      .first()
      .click()
      .catch(() => {});
    await h.wait(1200);
    await safeDump(`entry-${entry}`);
  }
  // 需要交互才能看到的状态
  const tryDump = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      out(`[explore] ${name} skipped: ${String(e.message).split('\n')[0]}`);
      const ok = await guard(page, name).then(
        () => true,
        () => false,
      );
      if (ok)
        await page.screenshot({ path: path.join(dir, `_skipped-${name}.png`) }).catch(() => {});
      return;
    }
    await safeDump(name);
  };
  await tryDump('interact-新建任务', async () => {
    await h.open();
    await page.getByRole('button', { name: '任务', exact: true }).first().click();
    await page.getByRole('button', { name: '新建任务' }).click();
    await h.wait(1000);
  });
  await tryDump('interact-更多功能', async () => {
    await h.open();
    await page.getByRole('button', { name: '更多功能' }).click();
    await h.wait(700);
  });
  await tryDump('interact-知识库加入文件夹', async () => {
    await h.open();
    await h.settings('知识与记忆');
    await page
      .getByRole('button', { name: /加入文件夹/ })
      .first()
      .click();
    await h.wait(4000);
  });
  await tryDump('interact-用量对比', async () => {
    await h.open();
    await h.settings('用量与分析');
    await page.getByRole('tab', { name: '对比' }).click();
    await h.wait(1200);
  });
  await tryDump('interact-编程会话权限菜单', async () => {
    await h.open();
    await h.mode('工作台');
    await h.newChat('Claude Code');
    await h.send('给 registerHandler 加一个可选的 id 参数', 8000);
    await page.getByRole('button', { name: /权限模式/ }).click();
    await h.wait(700);
  });
  await tryDump('interact-变更栏', async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '展开变更栏' }).click();
    await h.wait(1200);
  });
  for (const entry of ['知识 · 记忆 · 日程', '扩展 / MCP']) {
    await h.open();
    await page
      .getByRole('navigation', { name: '应用入口' })
      .getByRole('button', { name: entry })
      .click()
      .catch(() => {});
    await h.wait(1200);
    await safeDump(`entry-${entry.replace(/[\s/·]+/g, '_')}`);
  }
}
