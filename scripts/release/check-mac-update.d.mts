export declare function parseUpdateInfo(text: string): {
  version: string | undefined;
  files: Array<Record<string, string>>;
};
export declare function checkMacUpdate(
  distDir: string,
  expectedVersion: string | undefined,
  env?: Record<string, string | undefined>,
): { errors: string[]; warnings: string[] };
