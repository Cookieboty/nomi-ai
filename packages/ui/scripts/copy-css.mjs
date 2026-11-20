import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 递归复制 src 下的样式文件到目标输出目录 */
export function copyCss(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (statSync(source).isDirectory()) copyCss(source, target);
    else if (entry.endsWith('.css')) copyFileSync(source, target);
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isEntrypoint()) {
  // fileURLToPath：Windows 上 URL.pathname 会得到 /D:/... 这种非法路径
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  copyCss(join(root, 'src'), join(root, 'dist'));
}
