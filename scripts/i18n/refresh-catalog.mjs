/* eslint-disable no-console -- generator reports its result to the CLI */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = path.join(root, 'packages/i18n');
const localeRoot = path.join(packageRoot, 'src/locales');
const baseLanguage = 'zh';
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const dirs = (dir) =>
  fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
    .sort();

if (!fs.existsSync(path.join(localeRoot, baseLanguage))) {
  throw new Error(`Missing base language directory: ${baseLanguage}`);
}

const languages = dirs(localeRoot).sort((a, b) =>
  a === baseLanguage ? -1 : b === baseLanguage ? 1 : a.localeCompare(b),
);
const projects = dirs(path.join(localeRoot, baseLanguage));
const modules = [];
const allKeys = [];

for (const project of projects) {
  const projectRoot = path.join(localeRoot, baseLanguage, project);
  const files = fs
    .readdirSync(projectRoot)
    .filter((name) => name.endsWith('.json'))
    .sort();
  for (const file of files) {
    const module = file.slice(0, -5);
    const base = read(path.join(projectRoot, file));
    const baseKeys = new Set(Object.keys(base));
    for (const language of languages) {
      const languageFile = path.join(localeRoot, language, project, file);
      if (!fs.existsSync(languageFile)) throw new Error(`Missing ${language}/${project}/${file}`);
      const partKeys = new Set(Object.keys(read(languageFile)));
      for (const key of baseKeys)
        if (!partKeys.has(key)) throw new Error(`Missing ${language} key ${key}`);
      for (const key of partKeys)
        if (!baseKeys.has(key)) throw new Error(`Extra ${language} key ${key}`);
    }
    for (const key of Object.keys(base)) {
      allKeys.push(key);
    }
    modules.push({ project, module });
  }
}

const imports = [];
const names = Object.fromEntries(languages.map((language) => [language, []]));
for (const { project, module } of modules) {
  const safeModule = module.replace(/[^a-zA-Z0-9]/g, '_');
  const safeProject = project.replace(/[^a-zA-Z0-9]/g, '_');
  for (const language of [...languages].sort()) {
    const safeLanguage = language.replace(/[^a-zA-Z0-9]/g, '_');
    const name = `${safeProject}_${safeModule}_${safeLanguage}`;
    imports.push({
      path: `./locales/${language}/${project}/${module}.json`,
      line: `import ${name} from './locales/${language}/${project}/${module}.json';`,
    });
    names[language].push(`${safeProject}_${safeModule}: ${name}`);
  }
}

const dictionaries = languages
  .map((language) => `  ${JSON.stringify(language)}: { ${names[language].join(', ')} }`)
  .join(',\n');
const union = [...new Set(allKeys)].map((key) => JSON.stringify(key)).join(' | ') || 'never';
const importLines = imports.sort((a, b) => a.path.localeCompare(b.path)).map((entry) => entry.line);
const catalogFile = path.join(packageRoot, 'src/catalog.ts');
fs.writeFileSync(
  catalogFile,
  `${importLines.join('\n')}\n\nexport const DICTIONARIES = {\n${dictionaries},\n} as const;\n\nexport type TranslationKey = ${union};\nexport type Language = keyof typeof DICTIONARIES;\n\n/** 合并后的整张词典按语言缓存：t() 每次翻译都要查它，每次重新合并几千条会让界面明显卡顿 */\nconst merged = new Map<Language, Record<string, string>>();\n\nexport const getDictionary = (language: Language): Record<string, string> => {\n  let d = merged.get(language);\n  if (!d) {\n    // 无原型：查 __proto__ / constructor 之类的键不会命中继承属性\n    d = Object.assign(Object.create(null), ...Object.values(DICTIONARIES[language]));\n    merged.set(language, d);\n  }\n  return d;\n};\n`,
);
// 生成的是未排版的单行联合类型；提交的版本按 Prettier 排版，直接写完就排版，避免整文件 diff
execFileSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'prettier', '--write', catalogFile],
  {
    cwd: root,
    stdio: 'ignore',
  },
);
console.log(`Refreshed ${allKeys.length} localization keys for languages: ${languages.join(', ')}`);
