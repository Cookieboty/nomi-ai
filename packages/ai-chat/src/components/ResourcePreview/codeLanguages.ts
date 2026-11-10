import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { less } from '@codemirror/lang-less';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sass } from '@codemirror/lang-sass';
import { sql } from '@codemirror/lang-sql';
import { vue } from '@codemirror/lang-vue';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { csharp, dart, kotlin, objectiveC, scala } from '@codemirror/legacy-modes/mode/clike';
import { clojure } from '@codemirror/legacy-modes/mode/clojure';
import { cmake } from '@codemirror/legacy-modes/mode/cmake';
import { commonLisp } from '@codemirror/legacy-modes/mode/commonlisp';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { fSharp } from '@codemirror/legacy-modes/mode/mllike';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { r } from '@codemirror/legacy-modes/mode/r';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { gql } from '@codemirror/legacy-modes/mode/sql';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import type { Extension } from '@codemirror/state';
import { hcl } from 'codemirror-lang-hcl';
import { makefile } from 'codemirror-lang-makefile';
import { zig } from 'codemirror-lang-zig';

const stream = (parser: StreamParser<unknown>) => () => StreamLanguage.define(parser);
/** Grammars are bundled with this isolated preview module. Parsing and DOM drawing
 * remain incremental; switching workspaces or editor mode never fetches a grammar. */
const languages: Record<string, () => Extension> = {
  go,
  javascript,
  typescript: () => javascript({ typescript: true }),
  jsx: () => javascript({ jsx: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json,
  json5: () => javascript(),
  python,
  rust,
  java,
  c: cpp,
  cpp,
  php,
  markup: html,
  xml,
  css,
  scss: sass,
  sass: () => sass({ indented: true }),
  less,
  vue,
  sql,
  markdown,
  yaml,
  hcl,
  makefile,
  zig,
  swift: stream(swift),
  ruby: stream(ruby),
  bash: stream(shell),
  csharp: stream(csharp),
  fsharp: stream(fSharp),
  kotlin: stream(kotlin),
  scala: stream(scala),
  objectivec: stream(objectiveC),
  dart: stream(dart),
  cmake: stream(cmake),
  docker: stream(dockerFile),
  ini: stream(properties),
  properties: stream(properties),
  toml: stream(toml),
  protobuf: stream(protobuf),
  graphql: stream(gql),
  lua: stream(lua),
  perl: stream(perl),
  r: stream(r),
  erlang: stream(erlang),
  haskell: stream(haskell),
  clojure: stream(clojure),
  lisp: stream(commonLisp),
  latex: stream(stex),
  powershell: stream(powerShell),
  diff: stream(diff),
};
const cache = new Map<string, Extension>();
export const codeLanguages = Object.keys(languages);
export function codeLanguageSupport(language: string): Extension {
  let support = cache.get(language);
  if (!support) {
    support = languages[language]?.() ?? [];
    cache.set(language, support);
  }
  return support;
}
