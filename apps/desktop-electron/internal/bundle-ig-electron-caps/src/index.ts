/**
 * @nomi-ai/bundle-ig-electron-caps
 *
 * 插件包：Electron 主进程独占能力
 *   - SafeKeyStorePlugin：safeStorage 加密密钥库
 *   - FileSessionStorePlugin：JSONL 会话 + UserProfile 文件后端
 *   - ScreenPlugin：desktopCapturer 截屏
 *   - ClipboardPlugin：剪贴板读写 + 200ms 轮询变化事件
 *   - AsrPlugin：3 家 provider（whisper-local / openai-whisper / volc-asr）
 *   - TtsPlugin：4 家 provider（system / edge / openai / azure）
 *   - WakeWordPlugin：Porcupine（默认关）
 *   - ShortcutPlugin：全局快捷键 → 命令
 *
 * 入口即执行主进程守卫，非 Electron 主进程 import 会直接抛错。插件本身不加载 electron：
 * 平台能力（剪贴板、截屏、全局快捷键、safeStorage、userData 目录）由宿主在插件配置里注入，
 * 没注入时插件只记 warn、不提供对应能力（docs/design/core-host-decoupling.md §12 P4）。
 */
import { assertElectronMainProcess } from './env';

assertElectronMainProcess({ skipInTest: true });

export * from './env';
export * from './plugins';
export * from './seams';
