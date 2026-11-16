import { codeLanguages } from './codeLanguages';

export { codeLanguages } from './codeLanguages';
const supported = new Set(codeLanguages);
const extensionLanguages: Record<string, string> = {
  txt: 'text',
  text: 'text',
  go: 'go',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  fs: 'fsharp',
  fsx: 'fsharp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  swift: 'swift',
  m: 'objectivec',
  mm: 'objectivec',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'batch',
  cmd: 'batch',
  json: 'json',
  jsonc: 'json5',
  json5: 'json5',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  properties: 'properties',
  xml: 'markup',
  html: 'markup',
  htm: 'markup',
  svg: 'markup',
  xhtml: 'markup',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  vue: 'markup',
  svelte: 'markup',
  sql: 'sql',
  gql: 'graphql',
  graphql: 'graphql',
  proto: 'protobuf',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  cljs: 'clojure',
  lisp: 'lisp',
  tex: 'latex',
  cmake: 'cmake',
  tf: 'hcl',
  hcl: 'hcl',
  diff: 'diff',
  patch: 'diff',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
};

/**
 * 直接根据文件后缀名识别高亮语言；
 * 没有文件名、无后缀名（含以 `.` 开头无扩展名的隐藏文件）或未知后缀名，统一默认按 txt 纯文本（'text'）打开，不做内容推断。
 */
export function resolveCodeLanguage(path: string): string {
  const filename = path.replace(/\\/g, '/').split('/').pop()?.trim().toLowerCase() ?? '';
  if (!filename) return 'text';
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === filename.length - 1) return 'text';
  const extension = filename.slice(dotIndex + 1);
  const language =
    extensionLanguages[extension] ?? (supported.has(extension) ? extension : undefined);
  return language && supported.has(language) ? language : 'text';
}
