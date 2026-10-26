export declare const REQUIRED_MANIFESTS: string[];
export declare function verifyReleaseAssets(
  assetNames: string[],
  manifests: Record<string, string>,
  expectedVersion: string | undefined,
): { errors: string[] };
