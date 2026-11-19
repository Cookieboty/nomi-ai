---
'@nomi-ai/ai-chat': patch
---

style(side-tabs): 降低标签栏的视觉复杂度。第一层主标签去掉选中时压在底边上的 2px 下划线，只留背景色区分（选中 `--cd-color-active` / 悬停 `--cd-color-hover`）；第二层文件标签的选中指示从标签上沿挪到下沿，与内容区的分界重合。 / Simplify the side tab strips: the top-level tabs no longer draw a 2px underline over their bottom edge when selected (the background colour is the only cue), and the file tabs one level down move their selection bar from the top edge to the bottom edge, aligning it with the divider above the content.
