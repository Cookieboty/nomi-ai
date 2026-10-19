import path from 'node:path';
import { fileURLToPath } from 'node:url';

import babel from '@babel/core';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Adds a source location to JSX DOM elements in development builds.
 * The attribute is intentionally omitted from production output.
 */
export function tsdSourceBabelPlugin({ types: t }) {
  return {
    name: 'tsd-source-attribute',
    visitor: {
      JSXOpeningElement(elementPath, state) {
        const { node } = elementPath;
        if (
          !node.loc ||
          node.attributes.some(
            (attribute) => t.isJSXAttribute(attribute) && attribute.name.name === 'data-tsd-source',
          )
        ) {
          return;
        }

        const filename = state.filename ?? state.file?.opts?.filename;
        if (!filename) return;
        const relativeFilename = path.relative(repoRoot, filename).split(path.sep).join('/');
        node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier('data-tsd-source'),
            t.stringLiteral(`${relativeFilename}:${node.loc.start.line}`),
          ),
        );
      },
    },
  };
}

export function tsdSourceVitePlugin() {
  return {
    name: 'tsd-source-vite-transform',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.[cm]?[jt]sx?$/.test(id) || /\/node_modules\//.test(id)) return;
      const result = babel.transformSync(code, {
        filename: id,
        ast: false,
        sourceMaps: true,
        parserOpts: { plugins: ['jsx', 'typescript'] },
        plugins: [tsdSourceBabelPlugin],
      });
      return result?.code ? { code: result.code, map: result.map } : undefined;
    },
  };
}