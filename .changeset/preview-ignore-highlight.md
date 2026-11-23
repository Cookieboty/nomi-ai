---
---

feat(preview): 常见配置文件与隐藏文件按文件名识别高亮

`.gitignore`、`.dockerignore`、`.npmignore`、`.eslintignore`、`.prettierignore`、`.stylelintignore`
此前按纯文本打开、没有颜色，现在按文件名识别为忽略文件语法：注释灰色斜体、行首取反符与通配符按强调色、
其余路径按字符串色显示。`.gitattributes` 沿用同一套规则。

`Dockerfile`（含 `Dockerfile.*` 变体）、`Containerfile`、`Makefile`、`GNUmakefile`、`CMakeLists.txt`、
`Gemfile` / `Rakefile` / `Vagrantfile` / `Podfile` / `Brewfile`、`nginx.conf` 现在按固定文件名映射到
已捆绑的语法；`.editorconfig`、`.gitmodules`、`.gitconfig` 用 INI 形状着色（注释灰色、节名与键名强调色、
值字符串色）。
