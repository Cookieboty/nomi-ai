export declare const UPDATE_FILES: string[];
export declare function referencedFiles(yml: string): string[];
export declare function missingAssets(
  ymlByName: Record<string, string | undefined>,
  assetNames: string[],
): string[];
