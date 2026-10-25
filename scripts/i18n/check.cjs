/* eslint-disable @typescript-eslint/no-require-imports, no-console -- 构建期 Node 脚本（CommonJS） */
/**
 * CI 检查：源码里每个面向用户的中文字符串（t() 的 key、以及其余中文字面量）都必须在对应英文词典中有翻译。
 * 故意保留中文的文件见 config.cjs keepZh；单行豁免写 `// i18n-ignore`。
 * 反向检查：词典里的 key 必须仍出现在某处源码中（否则是死 key，退出码 1）。
 * 用法：node scripts/i18n/check.cjs [--missing out.json] [--fix-dead]   缺失 / 死 key 时退出码 1
 */
const ts = require(require.resolve('typescript', { paths: [process.cwd(), __dirname + '/../..'] }));
const fs = require('fs');
const path = require('path');

const cfg = require('./config.cjs');
const { walk } = require('./scan.cjs');

const root = path.resolve(__dirname, '../..');
const han = /[\u4e00-\u9fff]/;
const LOG =
  /(^|\.)(console|logger|log|debug|trace)\.|(^|\.)(debug|info|warn|error|trace|verbose|log)$/i;

function keysOf(file, all = false) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const src = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out = [];
  const ignored = (n) => {
    const l = src.getLineAndCharacterOfPosition(n.getStart()).line;
    return /i18n-ignore/.test(lines[l] || '') || /i18n-ignore/.test(lines[l - 1] || '');
  };
  const isLog = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p))
        return true;
      if (ts.isCallExpression(p)) {
        const e = p.expression.getText().replace(/\?\./g, '.');
        if (LOG.test(e) || /logger/i.test(e)) return true;
      }
    }
    return false;
  };
  const isI18nCall = (n) => {
    const p = n.parent;
    if (!ts.isCallExpression(p)) return false;
    const e = p.expression;
    return ts.isIdentifier(e) && (e.text === 't' || e.text === 'tr') && p.arguments[0] === n;
  };
  (function v(n) {
    const isStr = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
    if (
      (isStr || ts.isTemplateExpression(n) || ts.isJsxText(n)) &&
      (han.test(n.getText()) || (all && isI18nCall(n)))
    ) {
      if (!all && (isLog(n) || ignored(n))) return;
      let key;
      if (isStr) key = n.text;
      else if (ts.isJsxText(n))
        key = n
          .getText()
          .trim()
          .replace(/\s*\n\s*/g, ' ');
      else {
        key = n.head.text;
        n.templateSpans.forEach((s, i) => (key += `{${i}}` + s.literal.text));
      }
      const { line } = src.getLineAndCharacterOfPosition(n.getStart());
      out.push({ key, where: `${path.relative(root, file)}:${line + 1}` });
      return;
    }
    ts.forEachChild(n, v);
  })(src);
  return out;
}

function dictionaryFiles(relPath) {
  const full = path.join(root, relPath);
  if (!fs.statSync(full).isDirectory()) return [full];
  return fs
    .readdirSync(full)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(full, name));
}

function readDictionary(relPath) {
  const dict = {};
  for (const file of dictionaryFiles(relPath)) {
    const part = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(part)) {
      if (dict[key] !== undefined)
        throw new Error(`Duplicate i18n key ${JSON.stringify(key)} in ${relPath}`);
      dict[key] = value;
    }
  }
  return dict;
}

function removeKeys(relPath, keys) {
  const dead = new Set(keys);
  for (const file of dictionaryFiles(relPath)) {
    const part = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = false;
    for (const key of dead) {
      if (Object.prototype.hasOwnProperty.call(part, key)) {
        delete part[key];
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(file, JSON.stringify(part, null, 2) + '\n');
  }
}

const dictionaries = new Map();
const getDictionary = (relPath) => {
  if (!dictionaries.has(relPath)) dictionaries.set(relPath, readDictionary(relPath));
  return dictionaries.get(relPath);
};

const missing = {};
let count = 0;
for (const pkg of cfg.packages) {
  const dict = getDictionary(pkg.dict);
  const files = [];
  walk(path.join(root, pkg.dir), files);
  for (const f of files) {
    if (cfg.keepZh.some((re) => re.test(f.replace(/\\/g, '/')))) continue;
    for (const { key, where } of keysOf(f)) {
      count++;
      if (dict[key] === undefined) (missing[pkg.dict] ||= {})[key] ||= where;
    }
  }
}
// ---- 反向检查：死 key ----
const used = new Set();
const srcDirs = [...new Set([...cfg.packages.map((p) => p.dir), ...(cfg.keySources || [])])];
for (const d of srcDirs) {
  const files = [];
  walk(path.join(root, d), files);
  for (const f of files) for (const { key } of keysOf(f, true)) used.add(key);
}
const dead = {};
for (const dictPath of new Set(cfg.packages.map((p) => p.dict))) {
  const dict = getDictionary(dictPath);
  const d = Object.keys(dict).filter((k) => !used.has(k));
  if (!d.length) continue;
  dead[dictPath] = d;
  if (process.argv.includes('--fix-dead')) removeKeys(dictPath, d);
}
const deadN = process.argv.includes('--fix-dead')
  ? 0
  : Object.values(dead).reduce((a, d) => a + d.length, 0);
if (deadN) {
  for (const [dict, d] of Object.entries(dead)) {
    console.error(`\n${dict}: ${d.length} dead keys (not used in any source; run with --fix-dead)`);
    for (const k of d.slice(0, 50)) console.error(`  ${JSON.stringify(k)}`);
  }
}

const n = Object.values(missing).reduce((a, m) => a + Object.keys(m).length, 0);
const i = process.argv.indexOf('--missing');
if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify(missing, null, 1));
if (n) {
  for (const [dict, m] of Object.entries(missing)) {
    console.error(`\n${dict}: ${Object.keys(m).length} missing English translations`);
    for (const [k, w] of Object.entries(m).slice(0, 50))
      console.error(`  ${w}  ${JSON.stringify(k)}`);
  }
  process.exit(1);
}
if (deadN) process.exit(1);
console.log(`i18n: ${count} strings checked, all have English translations`);
