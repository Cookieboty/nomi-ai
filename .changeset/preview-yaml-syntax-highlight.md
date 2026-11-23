---
---

fix(preview): YAML 文件的键与未加引号的值补上语法着色

文件预览此前只给注释和带引号的字符串着色：YAML 语法把键标成 propertyName、把裸标量标成
content，而主题的 HighlightStyle 没有为这两类标签定义颜色，典型的 action.yml 打开后几乎
全部按默认文字色渲染，看起来像没有高亮。现在键按强调色显示、未加引号的标量按字符串色显示，
与 Markdown 代码块里 YAML 的观感一致；顺带也让 JSON 键、CSS 属性名有了颜色。
