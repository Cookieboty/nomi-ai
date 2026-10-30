/**
 * 渲染进程入口：界面需要的展示信息与能力位（纯数据）；不 import node:* 与 main 入口。
 */
import { rendererInfo } from '../shared/renderer';

import { manifest } from './manifest';

export const renderer = rendererInfo(manifest);
