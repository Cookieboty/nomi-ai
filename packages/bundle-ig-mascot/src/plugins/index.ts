export * from './Live2dSeamPlugin';
export * from './TouchInjectPlugin';
export * from './TtsLipSyncPlugin';
export * from './WaifuAgentPresetPlugin';
export * from './WaifuToolsPlugin';
// 主进程单独装载 `./plugins` 入口时，Service Key 必须与插件来自同一份模块实例
export { Live2dKey, Live2dKey as MascotKey } from '../seams/live2d';
export type { Live2dHost, Live2dService } from '../seams/live2d';
