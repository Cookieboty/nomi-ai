Write a commit message for the change below.
- Match the style of the repository's recent commits: their language, whether they use Conventional Commits and which scopes, and their length.
- Keep every line under 100 characters. Subject first; add a short body after a blank line only if the change needs explaining.
- Describe what changed and why, not the file list.

Recent commits:
{{.Subjects}}

Files:
{{.Stat}}

Diff{{if .Truncated}} (truncated){{end}}:
{{.Diff}}
