// @ts-check
/**
 * nomi/no-cli-literal 的白名单（docs/design/cli-plugin-architecture.md §7.3）：核心目录里仍按内置编程助手
 * 名字分支的文件。每一项写明原因；能改成能力位的就改，不往这里加新东西。
 * 单独一两行的特例用行内 `// eslint-disable-next-line nomi/no-cli-literal -- 原因`，不进这里。
 */
export const CLI_LITERAL_ALLOWLIST = [
  // 用量与额度：每个 CLI 的会话日志格式、额度来源（状态栏 / app-server / ACP 计费）、登录方式探测各不相同。
  // 待迁入插件的 usage 能力（plugin.usage）后移出白名单。
  'apps/desktop-electron/internal/core/src/usage/UsageService.ts',
  'apps/desktop-electron/internal/core/src/usage/authMode.ts',
  'apps/desktop-electron/internal/core/src/usage/UsageLogScanner.ts',
  'apps/desktop-electron/internal/core/src/usage/logParsers.ts',
  'packages/ai-chat/src/components/UsagePanel/Quota.tsx',
  // 进度监视：读本机各 CLI 自己的会话 / 状态文件（不经 Nomi 标签），格式按 CLI 区分。待迁入 plugin.progress。
  'apps/desktop-electron/internal/core/src/agents/AgentProgressService.ts',
  'apps/desktop-electron/internal/core/src/agents/parsers.ts',
  // 终端里启动第三方会话：每个 CLI 的环境变量 / 参数不同（plugin.terminal 已有数据，命令拼装仍在这里）。
  'apps/desktop-electron/internal/core/src/gateway/TerminalCommands.ts',
  'apps/desktop-electron/internal/core/src/gateway/windowsTerminal.ts',
  // 一次性迁移：撤销旧版本写进各 CLI 全局配置的第三方设置，按旧版本的文件格式逐个处理，不会再新增 CLI。
  'apps/desktop-electron/internal/core/src/gateway/revokeLegacy.ts',
  'apps/desktop-electron/internal/core/src/gateway/migrate.ts',
  // 斜杠命令：每个后端一个适配器的分发表（switch 本身就是按后端的注册表）。
  'packages/ai-chat/src/slash/adapters/index.ts',
];
