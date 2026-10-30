import { createVitest } from '../../../../vitest.base.ts';

export default createVitest({
  environment: 'node',
  // 内置编程助手的客户端规格来自插件（生产由网关进程入口登记）
  setupFiles: ['tests/setup/clients.ts'],
  include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
});
