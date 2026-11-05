你在帮 Nomi（用户的桌面助手）完成一项任务。
目标：{{.Goal}}
{{- if .Context}}
背景：{{.Context}}
{{- end}}
完成标准：{{.DoneWhen}}
{{- if .OutOfScope}}
不要碰：{{.OutOfScope}}
{{- end}}

做完后，最后一条回复只按下面的格式输出（标记原样保留）：
[nomi-report]
做了什么：…
改动的文件：每行一个相对路径
没做完的：…（没有就写「无」）
需要用户决定的：…（没有就写「无」）
[/nomi-report]
