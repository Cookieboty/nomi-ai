'use strict';

/**
 * e2e-headed 测试专用主进程（P9-11 Polish C）
 *
 * 不复用 packages/host-electron/src/core/Application.ts —— 那条链路会拉真实 AI runtime boot、
 * SafeKey、ScreenCapture 等重量级依赖，headed E2E 里不需要。
 *
 * 本文件只保留 headed 复跑所必需的最小片段：
 * 1. 通过 `AIRuntimeService.configure({ booter: FakeBooter, ... })` 启动一个
 *    完全内存化的 插件环境（LLM/Tool/UserProfile seams 全部用 fake）；
 * 2. 挂应用契约（`createAiRouter` + `@nomi-ai/contract` 的 IPC 传输）；
 * 3. 打开 1 个 BrowserWindow 载入 renderer.html，preload 暴露 `window.nomiTransport`
 *    （契约传输）与 `window.nomiHost`，与真实 preload 一致；
 * 4. `--profile=xxx` CLI 参数切换 waifu / chat-only / mcp-headless；
 *    `--no-window` 时不开窗口（供 E3 用）。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, webContents } = require('electron');

// -------------------------------------------------------------------
// 重写 userData / cache 路径到项目内，避免沙箱拦截 AppData\Roaming\Electron。
// 必须在 app.whenReady 之前调用。
// -------------------------------------------------------------------
const userDataRoot = path.resolve(__dirname, '..', '.userdata');
try {
  fs.mkdirSync(userDataRoot, { recursive: true });
  app.setPath('userData', userDataRoot);
  app.setPath('sessionData', userDataRoot);
  app.setPath('crashDumps', path.join(userDataRoot, 'crashDumps'));
  app.setPath('logs', path.join(userDataRoot, 'logs'));
  // 关闭 GPU cache / disk cache 到临时目录
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disk-cache-dir', path.join(userDataRoot, 'disk-cache'));
  // 沙箱拦截系统色彩配置文件（C:\Windows\system32\spool\drivers\color\*.icm）
  // 关掉硬件加速 + 用 sRGB 强制色彩，跳过读 ICM
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  app.commandLine.appendSwitch('disable-color-correct-rendering');
  app.commandLine.appendSwitch('no-sandbox');
} catch (err) {
  console.error('[main] failed to redirect userData:', err && err.stack ? err.stack : err);
}

const { createAiRouter, runtime, NoopRuntimeLogger } = require('@nomi-ai/ai-runtime');
const { createIpcServerTransport } = require('@nomi-ai/contract');

const { AIClient, toSdkContext } = require('@nomi-ai/ai-sdk');
const bundleBase = require('@nomi-ai/bundle-ig-base');

// -------------------------------------------------------------------
// 直接手工构造 IpcAdapter（不走 ai-runtime 的 createElectronIpcAdapter 内部的
// `(0, eval)('require')('electron')`——在 Playwright inspector 附着的 CJS 沙箱里
// eval 拿不到全局 require，会抛 ReferenceError）
// -------------------------------------------------------------------
function makeAdapter() {
  const wrap = (e) => ({
    senderId: e.sender.id,
    senderUrl: e.sender.getURL ? e.sender.getURL() : undefined,
    send: (ch, payload) => e.sender.send(ch, payload),
  });
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, async (e, ...args) => handler(wrap(e), ...args));
    },
    removeHandler(channel) {
      ipcMain.removeHandler(channel);
    },
    on(channel, listener) {
      ipcMain.on(channel, (e, ...args) => listener(wrap(e), ...args));
    },
    off(channel, listener) {
      ipcMain.off(channel, listener);
    },
    getAllWebContents() {
      return webContents.getAllWebContents();
    },
  };
}

const { LLMRegistryKey, ToolRegistryKey, UserProfileKey, makeDefaultUserProfile } = bundleBase;

// ---------------------------------------------------------------------------
// CLI 参数解析
// ---------------------------------------------------------------------------
function parseArgs() {
  const out = { profile: 'waifu', noWindow: false };
  for (const raw of process.argv.slice(1)) {
    if (raw.startsWith('--profile=')) out.profile = raw.slice('--profile='.length);
    if (raw === '--no-window') out.noWindow = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// FakeBooter · 复刻 e2e/helpers 的 seams，装配一个内存 插件 PluginContext
// ---------------------------------------------------------------------------
function createFakeCtx(profile) {
  const providers = new Map();
  const eventListeners = new Map();
  const hooks = new Map();
  const disposers = [];

  const on = (evt, fn) => {
    if (!hooks.has(evt)) hooks.set(evt, new Set());
    const set = hooks.get(evt);
    set.add(fn);
    return () => set.delete(fn);
  };
  const emit = () => {
    /* record no-op：Fake 环境下由 triggerEvent 实际派发 */
  };
  const triggerEvent = async (evt, payload) => {
    const set = eventListeners.get(evt);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        await fn(payload);
      } catch (err) {
        console.error(`[fake-ctx] listener for ${evt} threw`, err);
      }
    }
  };
  const runHooks = async (evt, payload) => {
    const set = hooks.get(evt);
    if (!set) return;
    for (const fn of Array.from(set)) {
      let rejected;
      const reject = (reason, code) => {
        rejected = Object.assign(new Error(reason), { code });
        throw rejected;
      };
      await fn({ payload, reject });
    }
  };

  const ctx = {
    profile,
    provide(key, value) {
      // 插件 ServiceKey 的稳定 id 是 `.key`（symbol）
      const id = key && key.key ? key.key : key;
      providers.set(id, value);
    },
    // AIClient / toSdkContext 用的入口
    inject(key) {
      const id = key && key.key ? key.key : key;
      return providers.get(id);
    },
    require(key) {
      const id = key && key.key ? key.key : key;
      return providers.get(id);
    },
    tryRequire(key) {
      const id = key && key.key ? key.key : key;
      return providers.get(id);
    },
    on,
    emit,
    triggerEvent,
    runHooks,
    subscribe(evt, fn) {
      if (!eventListeners.has(evt)) eventListeners.set(evt, new Set());
      const set = eventListeners.get(evt);
      set.add(fn);
      return () => set.delete(fn);
    },
    dispose(fn) {
      disposers.push(fn);
    },
    disposeAll() {
      while (disposers.length) {
        try {
          disposers.pop()();
        } catch {
          /* ignore */
        }
      }
    },
  };
  return ctx;
}

function seedFakeSeams(ctx, profile) {
  // LLM
  const chatCalls = [];
  const llm = {
    id: 'fake',
    chatCalls,
    async chat(req) {
      chatCalls.push(req);
      return {
        reqId: req.reqId,
        provider: 'fake',
        model: req.model,
        content: `echo: ${req.messages?.[req.messages.length - 1]?.content ?? ''}`,
        finishReason: 'stop',
      };
    },
    stream(req) {
      chatCalls.push(req);
      return (async function* () {
        yield { type: 'delta', content: 'hel' };
        yield { type: 'delta', content: 'lo' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    },
    abort() {
      /* noop */
    },
  };
  const llmRegistry = {
    _m: new Map([['fake', llm]]),
    register(p) {
      this._m.set(p.id, p);
    },
    get(id) {
      return this._m.get(id);
    },
    list() {
      return [...this._m.values()];
    },
  };
  ctx.provide(LLMRegistryKey, llmRegistry);

  // Tools（预置 echo，供 E2 触发）
  const toolMap = new Map();
  toolMap.set('echo', {
    name: 'echo',
    description: 'return text verbatim',
    dangerous: false,
    input: { type: 'echo-input' },
    async execute(input) {
      return { echoed: (input && input.text) || '' };
    },
  });
  ctx.provide(ToolRegistryKey, {
    register(t) {
      toolMap.set(t.name, t);
    },
    get(n) {
      return toolMap.get(n);
    },
    list() {
      return [...toolMap.values()];
    },
  });

  // UserProfile
  let userProfile = makeDefaultUserProfile
    ? makeDefaultUserProfile(1_700_000_000_000)
    : { identity: { nickname: 'user' }, updatedAt: Date.now() };
  const profileSubs = new Set();
  const profileService = {
    get() {
      return JSON.parse(JSON.stringify(userProfile));
    },
    getPath(p) {
      const segs = p.split('.');
      let cur = userProfile;
      for (const s of segs) {
        if (cur && typeof cur === 'object' && s in cur) cur = cur[s];
        else return undefined;
      }
      return cur;
    },
    async set(patch) {
      userProfile = deepMerge(userProfile, patch.patch);
      userProfile.updatedAt = Date.now();
      profileSubs.forEach((fn) => fn(userProfile));
      // AIClient.bindRuntimeBridges 用 ctx.on 挂 hook，要走 runHooks
      await ctx.runHooks('userProfile/changed', { profile: userProfile });
      return JSON.parse(JSON.stringify(userProfile));
    },
    async reset() {
      userProfile = makeDefaultUserProfile ? makeDefaultUserProfile() : { identity: {} };
      profileSubs.forEach((fn) => fn(userProfile));
      await ctx.runHooks('userProfile/changed', { profile: userProfile });
      return JSON.parse(JSON.stringify(userProfile));
    },
    subscribe(_evt, fn) {
      profileSubs.add(fn);
      return () => profileSubs.delete(fn);
    },
    async export() {
      return JSON.parse(JSON.stringify(userProfile));
    },
    async import(d) {
      userProfile = d;
      profileSubs.forEach((fn) => fn(userProfile));
      await ctx.runHooks('userProfile/changed', { profile: userProfile });
      return JSON.parse(JSON.stringify(userProfile));
    },
  };
  ctx.provide(UserProfileKey, profileService);

  return { llm, profileService };
}

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch !== undefined ? patch : base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs();
  const logger = {
    info: (msg, meta) => console.log(`[main]  ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`),
    warn: (msg, meta) => console.warn(`[main]  ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`),
    error: (msg, meta) => console.error(`[main]  ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`),
  };

  await app.whenReady();
  logger.info(`app ready · profile=${args.profile} · noWindow=${args.noWindow}`);

  // 1) 装配 FakeBooter + 启动 runtime
  const fakeCtx = createFakeCtx(args.profile);
  const seams = seedFakeSeams(fakeCtx, args.profile);
  const booter = {
    async boot(profile, _opts) {
      logger.info(`fake booter boot · profile=${profile}`);
      return fakeCtx;
    },
    async dispose() {
      fakeCtx.disposeAll();
    },
  };
  const service = runtime.configure({
    booter,
    lifecycle: { onBeforeQuit: () => () => undefined },
    logger: NoopRuntimeLogger,
  });
  const client = await service.start(args.profile, { home: app.getAppPath() });

  // 2) 挂 IPC 通道
  const adapter = makeAdapter();
  // AI 门面：应用契约（ai.* 过程 + 事件），经 contract:request / contract:frame 两个通道
  const ai = createAiRouter({ client, logger: NoopRuntimeLogger });
  const contractTransport = createIpcServerTransport(adapter, {
    // harness 只加载自家的 renderer.html
    resolveCaller: () => ({ surface: 'test', trusted: true }),
  });
  contractTransport.serve(ai.router);

  logger.info(`AI runtime ready (procedures=${Object.keys(ai.router.contract.procedures).length})`);

  // 3) 暴露 ctx / seams 到全局，供 E1 从主进程 side triggerEvent
  //    Playwright 通过 `electronApp.evaluate(({ app }) => globalThis.__aiE2eProbe.emitTts(...))` 触发
  //
  //    注意：AIClient.bindRuntimeBridges() 走的是 `ctx.on(event, hookCtx => hookCtx.payload)` 语义
  //    （hook），因此这里必须调 `runHooks` 而不是 `triggerEvent`（后者是 event bus）。
  globalThis.__aiE2eProbe = {
    async emitTts(payload) {
      // app.evaluate 只能传 JSON：音频字节在这里还原成 Uint8Array（契约事件要求二进制）
      const data = Array.isArray(payload.data) ? Uint8Array.from(payload.data) : payload.data;
      await fakeCtx.runHooks('tts/chunk', { ...payload, data });
    },
    async emitTurnEnd(payload) {
      await fakeCtx.runHooks('agent/turn-end', payload);
    },
    async emitToolExecuted(payload) {
      await fakeCtx.runHooks('tools/post-execute', payload);
    },
    async emitProfileChanged(payload) {
      await fakeCtx.runHooks('userProfile/changed', payload);
    },
    getProfile() {
      return seams.profileService.get();
    },
    getChatCalls() {
      return [...seams.llm.chatCalls];
    },
  };

  // 4) 开窗口（除非 --no-window）
  if (!args.noWindow) {
    const win = new BrowserWindow({
      width: 640,
      height: 480,
      show: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    await win.loadFile(path.join(__dirname, 'renderer.html'));
    logger.info(`window loaded · id=${win.id}`);
  }

  // 5) 打印 ready 标志，供 Playwright 检测启动完成
  console.log('E2E_HEADED_READY');
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

main().catch((err) => {
  console.error('[main] fatal', err && err.stack ? err.stack : err);
  process.exit(1);
});
