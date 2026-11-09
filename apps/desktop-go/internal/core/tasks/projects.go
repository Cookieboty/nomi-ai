package tasks

// 项目迁移（2.3.8 首启）：以前对话里派给 Nomi 的后台任务只记了工作区目录（Executor.Cwd），
// 现在 Nomi 按 projectId 取项目的文件夹。迁移时把这些目录也建成项目，任务补上 Executor.Project。

// ProjectCwds：还没有项目、只记了目录的 Nomi / 编程助手任务的目录
func (r *Runtime) ProjectCwds() []string {
	out := []string{}
	r.own(func() {
		for _, rec := range r.recs {
			ex := rec.Task.Executor
			if (ex.Kind == "nomi" || ex.Kind == "cli") && ex.Project == nil && ex.Cwd != nil && *ex.Cwd != "" {
				out = append(out, *ex.Cwd)
			}
		}
	})
	return out
}

// AdoptProjects：按 目录 → 项目 id 给这些任务补上 Executor.Project（落盘）
func (r *Runtime) AdoptProjects(byDir map[string]string) int {
	n := 0
	r.own(func() {
		for _, rec := range r.recs {
			t := rec.Task
			ex := t.Executor
			if ex.Project != nil || ex.Cwd == nil {
				continue
			}
			id := byDir[*ex.Cwd]
			if id == "" {
				continue
			}
			t.Executor.Project = &id
			if r.save(Record{Task: t, Attempts: rec.Attempts}) == nil {
				n++
			}
		}
	})
	return n
}
