/** 仓库根目录（含 pnpm-workspace.yaml 的目录） */
export declare function repoRoot(): string;
/** 仓库根目录下的路径，如 `repoPath('characters/nomi')` */
export declare function repoPath(...segments: string[]): string;
