// 录制用：把 'electron' 解析到最小桩（screen 由 globalThis.__fakeScreen 驱动）
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: new URL('./electron.cjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
