# 前端工程规范

这份规范适用于 `packages/ui`、`packages/ai-chat` 和 `packages/renderer`。目标是让组件、状态、样式和文案可以独立演进，降低桌面端多窗口之间的回归风险。规范是代码评审的默认基线；例外必须在代码附近写出原因，并在本文件的例外表登记。

## 目录与依赖边界

- `packages/ui` 只放跨窗口复用的设计令牌、无业务组件、无业务状态和无 Electron 依赖。组件必须通过 `packages/ui/src/index.ts` 暴露，页面禁止从 UI 包的内部路径导入。
- `packages/ai-chat` 和 `packages/renderer` 按功能组织页面。一个功能目录可以包含 `index.tsx`、局部子组件、hooks、services 和 CSS Module；跨功能复用的代码上移到 `packages/ui` 或对应包的 `shared` 目录。
- 依赖方向保持单向：`ui → React/图标库`，业务包 → `ui/types/sdk-client`，渲染层通过 preload 与主进程通信。UI 包不能依赖业务包、Electron 或窗口实现。
- 页面组件负责组合和路由，业务组件负责展示与交互，hooks 负责状态和副作用，services 负责 IPC/API 适配，纯计算放在 `utils`。组件中不直接拼接 IPC 通道名。

## 文件、组件和公共能力

- `ts`、`tsx`、`css`、`json` 源文件默认不超过 1,200 行。超过后按职责拆分：页面组合、展示组件、状态 hooks、服务适配和纯函数分别放入独立文件。
- 例外只允许是无法安全按职责切分的渲染引擎、协议生成物或外部数据文件；必须写明原因、所有者和后续拆分条件。
- 单个 React 组件默认不超过 300 行；超过 200 行时优先检查是否同时承担数据获取、状态机和布局组合。
- 重复出现两次且语义稳定的 UI 模式应提取到 `packages/ui`。公共组件必须提供键盘操作、焦点状态、禁用状态和可访问名称，并通过 `index.ts` 导出。
- 页面不得复制 Button、Modal、FormField、EmptyState、SectionTitle 等基础交互结构；需要新变体时扩展公共组件的明确 props，而不是在业务层覆盖一套平行实现。
- `useEffect` 只用于订阅、计时器、外部 API 和 DOM/IPC 同步。派生值在渲染期间计算；异步请求必须有取消或过期结果保护。

## 样式与主题

- 共享组件使用 `var(--cd-*)` 令牌和 `cd-` 类名前缀；业务专属样式使用 CSS Modules。禁止把颜色、间距、圆角和阴影散落为硬编码值。
- 共享 CSS 按职责拆分，入口文件只负责 `@import`；基础组件、主题覆盖和复杂控件不得混在一个长文件里。
- 每个可交互状态都要覆盖 hover、focus-visible、disabled 和 reduced-motion（适用时）。弹窗必须支持 Esc 关闭、焦点回收和屏幕阅读器标题。

## 多语言

- 面向用户的文案使用 `project.module.message` 稳定 key，调用 `t()` / `tr()`；日志、模型提示词、协议字段和解析数据按 i18n 检查配置登记例外。
- 多语言词典集中在 `packages/i18n/src/locales/<language>/<project>/<module>.json`，以 `zh` 作为基准语言。新增文案放入对应项目 / 模块文件，不在业务包新增语言文件，也不直接编辑生成的 `catalog.ts`。
- 插值占位符必须在 `zh` 与所有语言中保持一致；修改 key 时同步修改所有语言，并运行 `pnpm check:i18n`。
- 不在组件中缓存翻译结果。语言切换后由 `useLocale` 触发重新渲染；动态内容也必须走翻译函数。

## 性能与测试

- 面板和重量级依赖按功能懒加载；Rive 场景、图表和编辑器不得进入首屏公共 chunk。
- 列表使用稳定 key 和虚拟化/分页策略；事件监听、IPC 订阅、动画帧和 URL 对象必须在清理函数中释放。
- 公共组件测试行为和可访问性，业务组件测试关键状态转移，纯函数测试边界条件。测试不得依赖真实网络、系统时间或未隔离的 userData。
- 提交前至少运行受影响包的 `typecheck`、`lint`、`test`；跨包改动再运行根目录 `pnpm test`、`pnpm typecheck` 和 `pnpm build`。

## 评审清单

1. 依赖方向和公共组件边界是否清晰？
2. 文件和组件是否在行数预算内，例外是否有理由？
3. 是否存在重复交互、重复样式或未提取的稳定模式？
4. loading、empty、error、disabled、keyboard、focus 和 reduced-motion 状态是否完整？
5. 文案是否进入正确的语言块，插值和英文翻译是否同步？
6. 副作用是否可取消、可清理，是否会被旧请求结果覆盖？
7. 是否补充了行为测试并完成受影响包验证？

## 自动检查与例外

运行 `pnpm check:frontend` 检查前端源文件行数预算。当前登记的唯一例外是 `packages/avatar-runtime/src/layeredRig.ts`：它是 Canvas2D 动画与绘制的紧耦合引擎，拆分会改变渲染时序；后续只有在引入明确的动画/绘制模块边界时再拆解。所有其他超过 1,200 行的文件都必须拆分。
