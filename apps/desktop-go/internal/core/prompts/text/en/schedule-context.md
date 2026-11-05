It is now {{.Date}}, {{.Weekday}} {{.Time}}.
{{- if .Reminders}}
Today's reminders:
{{join .Reminders "\n"}}
{{- else}}
No reminders today.
{{- end}}
{{- if .Upcoming}}
Scheduled tasks still to run today: {{join .Upcoming ", "}}
{{- end}}
{{- if .Memory}}
{{.Memory}}
{{- end}}
