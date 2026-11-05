现在是 {{.Date}} 星期{{.WeekZh}} {{.Time}}。
{{- if .Reminders}}
今天的提醒：
{{join .Reminders "\n"}}
{{- else}}
今天没有待办提醒。
{{- end}}
{{- if .Upcoming}}
今天还会运行的定时任务：{{join .Upcoming "、"}}
{{- end}}
{{- if .Memory}}
{{.Memory}}
{{- end}}
