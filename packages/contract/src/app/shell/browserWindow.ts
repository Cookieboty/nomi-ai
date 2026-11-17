/**
 * 内置浏览器窗口（browserWindow.*）：对话旁标签区的「浏览器」标签把网页放在宿主的一个原生窗口里，
 * 贴着视图给它的区域显示。
 *
 * 为什么不是 iframe：子框架会被目标站点的 `X-Frame-Options` / `CSP frame-ancestors` 拒掉
 * （Google、GitHub 这类都拒嵌），浏览器还保留随时拒绝的权利，应用侧绕不过去。原生窗口里的网页是顶层文档，
 * 不参与这些判定，自签证书也走正常的警告页而不是被静默拦成一张空白页。
 *
 * 区域用视图 CSS px（与窗口 DIP 1:1），相对对话窗口内容区左上角：宿主加上对话窗口在屏幕上的位置得到
 * 原生窗口的绝对坐标，窗口移动 / 缩放时由宿主按这份区域重算。
 */
import { z } from 'zod';

/** 标签身份（视图定：会话 + 标签键）；同一个 id 复用同一个原生窗口 */
const BrowserWindowId = z.string().min(1).max(512);

/** 要贴住的区域（CSS px，相对对话窗口内容区左上角） */
export const BrowserRegion = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

/** browserWindow.show：把 url 打开在贴着 region 的原生窗口里（同一个 id 已经开着时换地址 / 重新贴位） */
export const BrowserWindowShowInput = z.object({
  id: BrowserWindowId,
  url: z.string().min(1).max(8192),
  region: BrowserRegion,
});

/** browserWindow.show 的结果：ok=false 时视图退到「在系统浏览器打开」的回退页 */
export const BrowserWindowShowResult = z.object({
  ok: z.boolean(),
  /** unsupported = 这个外壳没有原生浏览器窗口（浏览器预览 / MyGo 壳）；failed = 建窗失败 */
  reason: z.enum(['unsupported', 'failed']).optional(),
  message: z.string().max(500).optional(),
});

/** browserWindow.setRegion：更新区域；visible=false 时先藏起来（切标签、收面板、窗口最小化） */
export const BrowserWindowRegionInput = z.object({
  id: BrowserWindowId,
  region: BrowserRegion,
  visible: z.boolean(),
});

/** browserWindow.navigate / reload / close 的入参 */
export const BrowserWindowIdInput = z.object({ id: BrowserWindowId });
export const BrowserWindowNavigateInput = z.object({
  id: BrowserWindowId,
  url: z.string().min(1).max(8192),
});

/**
 * browserWindow.closeAll：把这条连接开着的浏览器窗口全收掉，不带 id。
 *
 * 视图卸载 / 整页重载（开发态热更新最常碰到）时用：这时逐个 close 的通知未必跑得完，
 * 旧窗口会留在屏幕上盖住别的界面——从宿主不解上下文，只能由视图说一句「都不要了」。
 */
export const BrowserWindowCloseAllInput = z.object({});

/**
 * browserWindow.sync：视图报「我这一侧现在开着的窗口 id 全集」，宿主把不在这份清单里的收掉。
 *
 * 为什么不能只靠逐个 close：窗口是宿主侧的原生视图，视图这边一旦重建（热更新、切会话重挂载、
 * 标签键变化）就再没有谁记得那个旧 id，「关标签 → 落一个 close(id)」会打空，窗口就永远
 * 浮在屏幕上。改成全集对齐后，「关」这个动作不再依赖某一次通知有没有送达：只要它不在
 * 当前挂载的清单里，宿主就会收掉。清单为空 = 一个都不该开着。
 */
export const BrowserWindowSyncInput = z.object({
  ids: z.array(BrowserWindowId).max(64),
});

/** browserWindow.sync 的结果：这次被收掉的窗口 id（视图不必处理，用于调试与测试） */
export const BrowserWindowSyncResult = z.object({
  closed: z.array(z.string()).max(64),
});

/** browserWindow.loaded：页面加载完成（ok=false 时 message 说明原因）；视图据此收掉进度条 */
export const BrowserWindowLoaded = z.object({
  id: z.string(),
  url: z.string().optional(),
  ok: z.boolean(),
  message: z.string().max(500).optional(),
});

/** browserWindow.closed：原生窗口没了（建窗后崩溃 / 被系统关掉 / 被全集对齐收掉），视图回到回退页 */
export const BrowserWindowClosed = z.object({ id: z.string() });
