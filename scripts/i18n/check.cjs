/* eslint-disable @typescript-eslint/no-require-imports, no-console -- 构建期 Node 脚本 */
/**
 * 统一 i18n 检查：稳定 key、所有语言完整性、占位符、重复与死 key。
 * 源码里的 t()/tr() 只能使用稳定 key；保留的中文文本必须显式列入 keepZh。
 */
const ts = require(require.resolve('typescript', { paths: [process.cwd(), __dirname + '/../..'] }));
const fs = require('fs');
const path = require('path');

const cfg = require('./config.cjs');
const root = path.resolve(__dirname, '../..');
const HAN = /[\u4e00-\u9fff]/;
const KEY = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z0-9-]+$/;
const LOG =
  /(^|\.)(console|logger|log|debug|trace)\.|(^|\.)(debug|info|warn|error|trace|verbose|log)$/i;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      if (!/^(node_modules|dist|coverage|locales)$/.test(name)) walk(file, files);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      files.push(file);
    }
  }
  return files;
}

function jsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name));
}

function placeholders(value) {
  if (typeof value !== 'string') return '';
  return [...value.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join('|');
}

const baseLanguage = cfg.baseLanguage || 'zh';
const catalogRoot = path.join(root, cfg.catalog);
const languages = fs.existsSync(catalogRoot)
  ? fs
      .readdirSync(catalogRoot)
      .filter((name) => fs.statSync(path.join(catalogRoot, name)).isDirectory())
      .sort((a, b) => (a === baseLanguage ? -1 : b === baseLanguage ? 1 : a.localeCompare(b)))
  : [];
const dictionaries = Object.fromEntries(languages.map((language) => [language, {}]));
const sourceByLanguage = Object.fromEntries(languages.map((language) => [language, {}]));
const baseTextByProject = {};
const errors = [];

if (!languages.includes(baseLanguage)) {
  errors.push(`base language ${JSON.stringify(baseLanguage)} is missing from ${cfg.catalog}`);
}
if (!languages.length) errors.push(`no language directories found in ${cfg.catalog}`);

for (const language of languages) {
  const languageRoot = path.join(catalogRoot, language);
  if (!fs.existsSync(languageRoot)) continue;
  for (const project of fs.readdirSync(languageRoot)) {
    const projectRoot = path.join(languageRoot, project);
    if (!fs.statSync(projectRoot).isDirectory()) continue;
    for (const file of jsonFiles(projectRoot)) {
      let part;
      try {
        part = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        errors.push(`${path.relative(root, file)}: invalid JSON (${error.message})`);
        continue;
      }
      for (const [key, value] of Object.entries(part)) {
        const where = `${path.relative(root, file)}:${key}`;
        if (!KEY.test(key)) errors.push(`${where}: key must be project.module.message`);
        if (HAN.test(key)) errors.push(`${where}: key must not contain Chinese characters`);
        if (typeof value !== 'string') errors.push(`${where}: value must be a string`);
        if (sourceByLanguage[language][key] && sourceByLanguage[language][key] !== where)
          errors.push(
            `duplicate key ${JSON.stringify(key)} in ${language}: ${sourceByLanguage[language][key]} and ${where}`,
          );
        sourceByLanguage[language][key] = where;
        dictionaries[language][key] = value;
        if (language === baseLanguage) {
          baseTextByProject[project] ||= {};
          if (baseTextByProject[project][value] && baseTextByProject[project][value] !== key)
            errors.push(`duplicate base text in ${project}: ${JSON.stringify(value)}`);
          baseTextByProject[project][value] = key;
        }
      }
    }
  }
}

const baseKeys = new Set(Object.keys(dictionaries[baseLanguage] || {}));
for (const language of languages) {
  const keys = new Set(Object.keys(dictionaries[language]));
  for (const key of baseKeys) {
    if (!keys.has(key)) errors.push(`missing ${language} translation for ${key}`);
    else if (
      placeholders(dictionaries[baseLanguage][key]) !== placeholders(dictionaries[language][key])
    )
      errors.push(`placeholder mismatch for ${key} between ${baseLanguage} and ${language}`);
  }
  for (const key of keys) {
    if (!baseKeys.has(key))
      errors.push(`extra ${language} key not present in ${baseLanguage}: ${key}`);
  }
}

function isIgnored(node, lines, source) {
  const line = source.getLineAndCharacterOfPosition(node.getStart()).line;
  return /i18n-ignore/.test(lines[line] || '') || /i18n-ignore/.test(lines[line - 1] || '');
}

function isLog(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
    if (ts.isCallExpression(parent)) {
      const expression = parent.expression.getText().replace(/\?\./g, '.');
      if (LOG.test(expression) || /logger/i.test(expression)) return true;
    }
  }
  return false;
}

function sourceEntries(file, project) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const entries = [];
  function visit(node) {
    const stringNode = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
    const jsxNode = ts.isJsxText(node);
    const rawValue = stringNode
      ? node.text
      : jsxNode
        ? node
            .getText()
            .trim()
            .replace(/\s*\n\s*/g, ' ')
        : '';
    if (
      (stringNode || jsxNode) &&
      (HAN.test(node.getText()) || KEY.test(rawValue)) &&
      !isLog(node) &&
      !isIgnored(node, lines, source)
    ) {
      const parent = node.parent;
      const inTranslate =
        stringNode &&
        ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        (parent.expression.text === 't' || parent.expression.text === 'tr') &&
        parent.arguments[0] === node;
      const value = rawValue;
      if (value)
        entries.push({
          value,
          inTranslate,
          where: `${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          project,
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return entries;
}

const used = new Set();
for (const sourceConfig of cfg.sources) {
  for (const file of walk(path.join(root, sourceConfig.dir))) {
    const relative = file.replaceAll('\\', '/');
    if (cfg.keepZh.some((pattern) => pattern.test(relative))) continue;
    for (const entry of sourceEntries(file, sourceConfig.project)) {
      if (entry.inTranslate && !KEY.test(entry.value))
        errors.push(
          `${entry.where}: use a stable i18n key instead of ${JSON.stringify(entry.value)}`,
        );
      if (
        entry.inTranslate &&
        KEY.test(entry.value) &&
        !Object.prototype.hasOwnProperty.call(dictionaries[baseLanguage], entry.value)
      )
        errors.push(`${entry.where}: unknown i18n key ${JSON.stringify(entry.value)}`);
      if (!entry.inTranslate && !KEY.test(entry.value))
        errors.push(
          `${entry.where}: Chinese text is not in the unified catalog: ${JSON.stringify(entry.value)}`,
        );
      if (KEY.test(entry.value)) used.add(entry.value);
    }
  }
}

// Other packages can return stable translation keys to the UI. Include them in dead-key analysis.
for (const dir of cfg.keySources) {
  for (const file of walk(path.join(root, dir))) {
    for (const entry of sourceEntries(file, 'ui')) {
      if (KEY.test(entry.value)) {
        if (!Object.prototype.hasOwnProperty.call(dictionaries[baseLanguage], entry.value))
          errors.push(`${entry.where}: unknown i18n key ${JSON.stringify(entry.value)}`);
        used.add(entry.value);
      }
    }
  }
}

const dead = Object.keys(dictionaries[baseLanguage] || {}).filter((key) => !used.has(key));
if (dead.length) errors.push(`dead i18n keys (${dead.length}): ${dead.join(', ')}`);

if (errors.length) {
  for (const error of errors) console.error(`i18n: ${error}`);
  process.exit(1);
}

console.log(
  `i18n: ${Object.keys(dictionaries[baseLanguage] || {}).length} stable keys, ${languages.join('/') || 'no languages'} complete, no duplicate or dead keys`,
);
