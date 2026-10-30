export * from './AvatarSeamPlugin';
export * from './CompanionAgentPresetPlugin';
export * from './CompanionToolsPlugin';
// 主进程单独装载 `./plugins` 入口时，Service Key 必须与插件来自同一份模块实例
export { AvatarKey } from '../seams/avatar';
export type { AvatarHost, AvatarReport, AvatarService } from '../seams/avatar';
