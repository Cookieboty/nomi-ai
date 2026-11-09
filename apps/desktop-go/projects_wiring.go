package main

// 项目（core/projects）：存储、契约过程、给 broker / 编排器的目录来源，以及首启迁移
// （以前每个会话一个目录 → 每个目录建一个单文件夹项目，会话改成引用 projectId）。

import (
	"log"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codinghandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// wireProjects：建项目存储，注册 project.*，把项目接到 Nomi 的权限 broker 上
func wireProjects(router *contract.Router, userData string, b *desktop.PermissionBroker) *projects.Store {
	s := projects.New(projects.Deps{
		File:   filepath.Join(userData, "projects.json"),
		Check:  b.CheckProjectFolder,
		Inside: b.InsideDir,
		Emit:   func(l []projects.View) { router.Emit("project.changed", l) },
	})
	codinghandlers.RegisterProjects(router, s)
	b.ProjectRoots = func(id string) (string, []string) {
		r := s.Roots(id)
		return r.Primary, r.Extra
	}
	b.ProjectName = func(id string) string {
		p, _ := s.Get(id)
		return p.Name
	}
	return s
}

// seedProjects：首启迁移（projects.json 还不存在时做一次）。dirs 是以前用过的工作目录（会话、标签、最近列表）；
// 返回 目录 → 项目 id，调用方据此把会话改成引用 projectId
func seedProjects(s *projects.Store, dirs []string) map[string]string {
	if s.Existed() {
		return nil
	}
	m, err := s.Seed(dirs)
	if err != nil {
		log.Printf("[projects] WARN seed failed: %v", err)
		return nil
	}
	log.Printf("[projects] seeded %d projects from %d previous workspaces", len(s.List()), len(dirs))
	return m
}

// migrateToProjects：首启迁移。以前侧栏按会话的目录分组（Nomi 对话 meta.cwd、编程助手标签的 cwd）：
// 每个目录建一个单文件夹项目，Nomi 对话的 meta 改成 projectId（去掉 cwd），标签与后台任务补上 projectId
func migrateToProjects(s *projects.Store, conv *convstore.Store, o *harness.Orchestrator, rt *tasks.Runtime) {
	if s.Existed() {
		return
	}
	dirs := []string{}
	if conv != nil {
		_, err := conv.RewriteMetas(func(m map[string]any) bool {
			if c, _ := m["cwd"].(string); c != "" {
				dirs = append(dirs, c)
			}
			return false
		})
		if err != nil {
			log.Printf("[projects] WARN read conversations: %v", err)
			return
		}
	}
	if o != nil {
		dirs = append(dirs, jsrt.Call(o.TabCwds)...)
	}
	if rt != nil {
		dirs = append(dirs, rt.ProjectCwds()...)
	}
	byDir := seedProjects(s, dirs)
	if byDir == nil {
		return
	}
	if conv != nil {
		n, err := conv.RewriteMetas(func(m map[string]any) bool {
			c, _ := m["cwd"].(string)
			if c == "" {
				return false
			}
			delete(m, "cwd")
			if id := byDir[c]; id != "" {
				m["projectId"] = id
			}
			return true
		})
		if err != nil {
			log.Printf("[projects] WARN rewrite conversations: %v", err)
		} else if n > 0 {
			log.Printf("[projects] %d conversations now reference projects", n)
		}
	}
	if o != nil {
		jsrt.Run(func() { o.AdoptProjects(byDir) })
	}
	if rt != nil {
		if n := rt.AdoptProjects(byDir); n > 0 {
			log.Printf("[projects] %d tasks now reference projects", n)
		}
	}
}

// taskRuntime：任务服务没起来时为 nil
func taskRuntime(s *tasks.Service) *tasks.Runtime {
	if s == nil {
		return nil
	}
	return s.Runtime
}
