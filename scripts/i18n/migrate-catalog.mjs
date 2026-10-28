import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const uiSource = path.join(root, 'packages/ui/src/locales/en');
const electronSource = path.join(root, 'packages/host-electron/src/i18n/en.json');
const outRoot = path.join(root, 'packages/i18n');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const shortHash = (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 6);

function slug(value) {
  const withoutPlaceholders = value.replace(/\{\w+\}/g, ' ');
  const words = withoutPlaceholders
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 8).join('-') || 'message';
}

function buildEntries(project, module, source) {
  const used = new Set();
  const entries = [];
  for (const [legacy, english] of Object.entries(source)) {
    const base = slug(english);
    let key = `${project}.${module}.${base}`;
    if (used.has(key)) key = `${key}-${shortHash(legacy)}`;
    while (used.has(key)) key = `${key}-${shortHash(`${legacy}:${key}`)}`;
    used.add(key);
    entries.push({ key, legacy, english });
  }
  return entries;
}

const uiFiles = fs
  .readdirSync(uiSource)
  .filter((file) => file.endsWith('.json'))
  .sort();
const modules = [];
// 仅用于一次性把旧词典里的中文原文替换成稳定 key；不会写入运行时兼容映射。
const sourceKeyMap = { ui: {}, electron: {} };
const dictionaries = { zh: {}, en: {} };

for (const file of uiFiles) {
  const module = file.slice(0, -'.json'.length);
  const entries = buildEntries('ui', module, readJson(path.join(uiSource, file)));
  const zh = {};
  const en = {};
  for (const entry of entries) {
    zh[entry.key] = entry.legacy;
    en[entry.key] = entry.english;
    sourceKeyMap.ui[entry.legacy] = entry.key;
  }
  modules.push({ project: 'ui', module, zh, en });
}

const electronEntries = buildEntries('electron', 'common', readJson(electronSource));
const electronZh = {};
const electronEn = {};
for (const entry of electronEntries) {
  electronZh[entry.key] = entry.legacy;
  electronEn[entry.key] = entry.english;
  sourceKeyMap.electron[entry.legacy] = entry.key;
}
modules.push({ project: 'electron', module: 'common', zh: electronZh, en: electronEn });

for (const language of ['zh', 'en']) {
  for (const module of modules) {
    const file = path.join(
      outRoot,
      'src/locales',
      language,
      module.project,
      `${module.module}.json`,
    );
    writeJson(file, module[language]);
    dictionaries[language] = { ...dictionaries[language], ...module[language] };
  }
}

const imports = [];
for (const module of modules) {
  const variable = `${module.project}_${module.module.replace(/[^a-zA-Z0-9]/g, '_')}`;
  imports.push(
    `import ${variable}_zh from './locales/zh/${module.project}/${module.module}.json';`,
    `import ${variable}_en from './locales/en/${module.project}/${module.module}.json';`,
  );
}
const mergeZh = modules
  .map((m) => `${m.project}_${m.module.replace(/[^a-zA-Z0-9]/g, '_')}_zh`)
  .join(', ');
const mergeEn = modules
  .map((m) => `${m.project}_${m.module.replace(/[^a-zA-Z0-9]/g, '_')}_en`)
  .join(', ');
const keyUnion = Object.keys(dictionaries.en)
  .map((key) => JSON.stringify(key))
  .join(' | ');

const packageDir = path.join(outRoot);
fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
fs.writeFileSync(
  path.join(packageDir, 'src/catalog.ts'),
  `${imports.join('\n')}\n\nexport const DICTIONARIES = {\n  zh: { ${mergeZh} },\n  en: { ${mergeEn} },\n} as const;\n\nexport type TranslationKey = ${keyUnion};\nexport type Language = keyof typeof DICTIONARIES;\n\nexport const getDictionary = (language: Language): Record<string, string> =>\n  Object.assign({}, ...Object.values(DICTIONARIES[language])) as Record<string, string>;\n`,
);

const packageJson = {
  name: '@nomi-ai/i18n',
  version: '0.1.0',
  private: true,
  description: 'Nomi unified localization catalog and runtime',
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  },
  files: ['dist'],
  scripts: {
    build: 'node ../../scripts/run-bin.mjs tsc -p tsconfig.json',
    typecheck: 'node ../../scripts/run-bin.mjs tsc -p tsconfig.json --noEmit',
    lint: 'eslint .',
    clean: 'node ../../scripts/run-bin.mjs rimraf dist',
  },
  devDependencies: { typescript: '^6.0.3', rimraf: '^6.1.3' },
};
writeJson(path.join(packageDir, 'package.json'), packageJson);
writeJson(path.join(packageDir, 'tsconfig.json'), {
  extends: '../../tsconfig.base.json',
  compilerOptions: { outDir: 'dist', rootDir: 'src', lib: ['ES2022'], resolveJsonModule: true },
  include: ['src/**/*'],
});

const sourceDirs = [
  ['packages/ai-chat/src', sourceKeyMap.ui],
  ['packages/renderer/src', sourceKeyMap.ui],
  ['packages/voice/src', sourceKeyMap.ui],
  ['packages/ui/src', sourceKeyMap.ui],
  ['packages/core/src', sourceKeyMap.electron],
  ['packages/host-electron/src', sourceKeyMap.electron],
  ['packages/cli-sdk/src', sourceKeyMap.electron],
  ['packages/cli-plugins/src', sourceKeyMap.electron],
];

function walk(dir, files = []) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      if (!/node_modules|dist|coverage|locales$/.test(name)) walk(file, files);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.[^.]+$/.test(name)) files.push(file);
  }
  return files;
}

const ts = await import('typescript');
const keepZh = [
  /voice[\\/]src[\\/]wake\.ts$/,
  /renderer[\\/]src[\\/]mascot[\\/]licenseTerms\.ts$/,
  /electron[\\/]src[\\/]desktop[\\/]p2tools\.ts$/,
  /electron[\\/]src[\\/]desktop[\\/]p3tools\.ts$/,
  /electron[\\/]src[\\/]desktop[\\/]tools\.ts$/,
  /electron[\\/]src[\\/]cli[\\/]delegate[\\/](core|DelegateService)\.ts$/,
  /electron[\\/]src[\\/]tts[\\/]legacy[\\/]/,
  /electron[\\/]src[\\/]knowledge[\\/](tokenize|answer)\.ts$/,
  /electron[\\/]src[\\/]schedule[\\/]recurrence\.ts$/,
  /electron[\\/]src[\\/]agents[\\/]parsers\.ts$/,
  /electron[\\/]src[\\/]memory[\\/]episodes\.ts$/,
  /electron[\\/]src[\\/]sandbox[\\/]/,
  /electron[\\/]src[\\/]desktop[\\/]parse[\\/]/,
];

function rewriteSource(file, map) {
  const relative = file.replaceAll('\\', '/');
  if (keepZh.some((re) => re.test(relative))) return;
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const replacements = [];
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const key = map[node.text];
      if (key)
        replacements.push({
          start: node.getStart(source),
          end: node.getEnd(),
          value: JSON.stringify(key),
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let out = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, replacement.start)}${replacement.value}${out.slice(replacement.end)}`;
  }
  if (out !== text) fs.writeFileSync(file, out);
}

for (const [dir, map] of sourceDirs) {
  for (const file of walk(path.join(root, dir))) rewriteSource(file, map);
}

// The old dictionaries are no longer sources of truth. Tests and consumers use the unified package.
for (const file of uiFiles) fs.rmSync(path.join(uiSource, file), { force: true });
fs.rmSync(path.join(uiSource, 'index.ts'), { force: true });
fs.rmSync(electronSource, { force: true });

console.log(
  `Generated ${Object.keys(dictionaries.en).length} stable localization keys in ${outRoot}`,
);
