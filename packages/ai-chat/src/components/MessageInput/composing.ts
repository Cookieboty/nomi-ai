/** 输入框的组字（IME）判定：受控 value 与 WebView2 的组字事件之间对齐用。 */

/**
 * 这次 input 是不是输入法在组字。Chromium / WebView2 组字时 `inputType` 是
 * `insertCompositionText`，`isComposing` 一般也为 true；两个都认 —— 本机 WebView2 出现过
 * `isComposing` 漏报，只认它就会把组字中途的 input 当成正常输入，把残字写回受控 value 吞掉。
 * 两样都拿不到时才回落到 compositionstart 挂的标记。
 */
export function isCompositionInput(native: InputEvent, composingFlag: boolean): boolean {
  if (native.inputType === 'insertCompositionText' || native.isComposing === true) return true;
  return native.inputType === undefined && composingFlag;
}
