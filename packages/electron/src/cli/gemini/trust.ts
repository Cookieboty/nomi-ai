/**
 * Gemini CLI 的文件夹信任（https://geminicli.com/docs/cli/trusted-folders/）。
 *
 * Nomi 不替用户全局跳过 Gemini 的信任检查：对话进程不设 `GEMINI_CLI_TRUST_WORKSPACE`，
 * 是否信任某个工作区完全由 Gemini 自己的 trustedFolders.json 决定。ACP 进程是 headless 的，
 * 弹不出信任对话框，遇到未受信任的目录会以 55 退出 —— 这里把它识别出来，换成可操作的提示；
 * 用户确认后可以只把那一个文件夹写进 Gemini 的受信任列表（见 trustedFolders.ts）。
 *
 * 唯一例外是账号登录：它跑在 Nomi 自己新建的、空的暂存目录里（同时也是那次登录的 GEMINI_CLI_HOME），
 * 信任的只是这个暂存目录本身，不涉及用户的任何工作区。
 */
import { t } from '../../i18n';

/** gemini-cli FatalUntrustedWorkspaceError 的退出码 */
export const GEMINI_UNTRUSTED_EXIT_CODE = 55;

const UNTRUSTED_RE = /not running in a trusted directory|--skip-trust|GEMINI_CLI_TRUST_WORKSPACE/i;

/** ACP 进程是否因为工作区未受信任而退出 */
export function isGeminiUntrustedExit(exitCode: number | null, stderr: string): boolean {
  return exitCode === GEMINI_UNTRUSTED_EXIT_CODE || UNTRUSTED_RE.test(stderr);
}

/** 给用户看的说明：可以在错误卡片上点「信任此文件夹」（只信任这一个），或者自己去 Gemini 里信任 */
export function geminiUntrustedMessage(cwd: string): string {
  return t(
    'Gemini CLI 不信任当前文件夹（{0}），已拒绝在这里运行。可以点下方「信任此文件夹」，或在终端里进入该文件夹运行一次 `gemini` 并选择信任，然后重试。',
    cwd,
  );
}

/** 工作区未受信任导致的失败；带上被拒绝的文件夹，界面据此显示「信任此文件夹」按钮 */
export class GeminiUntrustedError extends Error {
  constructor(
    readonly folder: string,
    options?: { cause?: unknown },
  ) {
    super(geminiUntrustedMessage(folder), options);
    this.name = 'GeminiUntrustedError';
  }
}

/**
 * 登录用的环境：GEMINI_CLI_HOME 指向暂存目录，信任也只作用于暂存目录（进程 cwd 必须就是它）。
 * 用户的全局设置、受信任文件夹列表和工作区都不会被读到或改动。
 */
export function geminiLoginEnv(stagingDir: string): Record<string, string> {
  return { GEMINI_CLI_HOME: stagingDir, GEMINI_CLI_TRUST_WORKSPACE: 'true' };
}
