/**
 * 测试前登记内置编程助手的客户端规格（P9.5）：生产里由 Electron 的网关进程入口从插件组装，
 * 网关内核本身只带 Nomi 自己的规格。这里按相对路径直接用插件源码里的数据（不给网关包加依赖），
 * 测试跑的就是插件真正交给内核的规格。
 */
import { BUILTIN_GATEWAY_ENTRIES } from '../../../cli-plugins/src/gateways';
import { registerClientSpec } from '../../src/clients/index';

for (const e of BUILTIN_GATEWAY_ENTRIES) registerClientSpec(e.clientSpec);
