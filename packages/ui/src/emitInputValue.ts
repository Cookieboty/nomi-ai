/**
 * 绕过 React 的取值跟踪写入原生输入框并派发 input 事件，调用方的 onChange 照常收到原生事件。
 * 自绘控件（日期选择、数字步进）改值时用。
 */
export function emitInputValue(el: HTMLInputElement, next: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
