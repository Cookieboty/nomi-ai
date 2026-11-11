package main

// 项目（core/projects）：存储、契约过程、给 broker / 编排器 / 预览的目录来源，以及迁移
// （以前每个会话一个目录 → 每个目录建一个单文件夹项目，会话改成引用 projectId）。

import (
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codinghandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
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

// migrationPendingFile：迁移进行中的标记。建项目之前写、全部步骤成功后删；
// 还在就说明上次迁移中途失败，启动时整套重来（每一步都可以重复做）
const migrationPendingFile = "projects-migration.pending"

// migrateToProjects：迁移到项目。以前侧栏按会话的目录分组（Nomi 对话 meta.cwd、编程助手标签的 cwd）：
// 每个目录建一个单文件夹项目，Nomi 对话的 meta 改成 projectId（去掉 cwd），标签与后台任务补上 projectId。
//   - 全套（对话 + 标签 + 任务）在 projects.json 还不存在、或上次没做完（有 pending 标记）时跑，全部成功才删标记；
//   - 对话只在迁上项目后才去掉 cwd。目录此刻不能用（外接盘没挂、网络目录离线）的保留 cwd，
//     之后每次启动都再试（现在的对话不再写 meta.cwd，留着 cwd 又没有 projectId 的只会是没迁完的）
func migrateToProjects(s *projects.Store, userData string, conv *convstore.Store, o *harness.Orchestrator, rt *tasks.Runtime) {
	pending := filepath.Join(userData, migrationPendingFile)
	_, statErr := os.Stat(pending)
	full := !s.Existed() || statErr == nil
	if full {
		if err := utils.WritePrivateFileAtomic(pending, []byte("1\n")); err != nil {
			log.Printf("[projects] WARN mark migration: %v", err)
			return
		}
	}
	dirs := []string{}
	if conv != nil {
		_, err := conv.RewriteMetas(func(m map[string]any) bool {
			if c := unmigratedCwd(m); c != "" {
				dirs = append(dirs, c)
			}
			return false
		})
		if err != nil {
			log.Printf("[projects] WARN read conversations: %v", err)
			return
		}
	}
	if full && o != nil {
		dirs = append(dirs, jsrt.Call(o.TabCwds)...)
	}
	if full && rt != nil {
		dirs = append(dirs, rt.ProjectCwds()...)
	}
	if !full && len(dirs) == 0 {
		return
	}
	byDir, err := s.Seed(dirs)
	if err != nil {
		log.Printf("[projects] WARN seed failed: %v", err)
		return
	}
	ok := true
	if conv != nil {
		n, err := conv.RewriteMetas(func(m map[string]any) bool {
			id := byDir[unmigratedCwd(m)]
			if id == "" {
				return false
			}
			delete(m, "cwd")
			m["projectId"] = id
			return true
		})
		if err != nil {
			ok = false
			log.Printf("[projects] WARN rewrite conversations: %v", err)
		} else if n > 0 {
			log.Printf("[projects] %d conversations now reference projects", n)
		}
	}
	if !full {
		return
	}
	if o != nil {
		jsrt.Run(func() { o.AdoptProjects(byDir) })
	}
	if rt != nil {
		n, err := rt.AdoptProjects(byDir)
		if err != nil {
			ok = false
			log.Printf("[projects] WARN adopt tasks: %v", err)
		}
		if n > 0 {
			log.Printf("[projects] %d tasks now reference projects", n)
		}
	}
	if !ok {
		return
	}
	if err := os.Remove(pending); err != nil && !os.IsNotExist(err) {
		log.Printf("[projects] WARN clear migration mark: %v", err)
	}
	log.Printf("[projects] migrated %d previous workspaces into %d projects", len(byDir), len(s.List()))
}

// unmigratedCwd：还没迁到项目的对话的旧工作目录（有 cwd、没有 projectId）
func unmigratedCwd(m map[string]any) string {
	if p, _ := m["projectId"].(string); p != "" {
		return ""
	}
	c, _ := m["cwd"].(string)
	return strings.TrimSpace(c)
}

// projectRootsOf：path 所在项目此刻可用的文件夹（预览按它放行附加文件夹、别的项目文件夹里的文件）
func projectRootsOf(s *projects.Store) func(string) []string {
	return func(path string) []string {
		p, ok := s.FindContaining(path)
		if !ok {
			return nil
		}
		r := s.Roots(p.ID)
		if r.Primary == "" {
			return nil
		}
		return append([]string{r.Primary}, r.Extra...)
	}
}

// taskRuntime：任务服务没起来时为 nil
func taskRuntime(s *tasks.Service) *tasks.Runtime {
	if s == nil {
		return nil
	}
	return s.Runtime
}
