package gwstore

import (
	"fmt"
	"sync"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func mustObj(t *testing.T, js string) *u.Obj {
	t.Helper()
	v, err := u.Parse([]byte(js))
	if err != nil {
		t.Fatal(err)
	}
	return v.(*u.Obj)
}

// #195：锁外读（nomiContext / 路由 / 端点 / 编程助手默认值 …）与写（setAssignment / resetToken /
// upsertProvider）并发。修复前读端无锁深拷贝 / 遍历存储里的 map，go test -race 报数据竞争
// （极端时是 fatal concurrent map read and map write）；修复后读端只读已发布的不可变快照。
func TestServiceConcurrentReadsAndWrites(t *testing.T) {
	dir := t.TempDir()
	s := NewServiceForUserData(dir, nil, nil)
	s.AttachRuntime(RuntimeDeps{Root: dir, Lazy: true, Env: map[string]string{},
		Fork: func() GatewayChild { return &syncChild{} }})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	s.Start()
	defer s.Dispose()

	pair := map[string]string{"pa": "ma", "pb": "mb"}
	for id, m := range pair {
		in := mustObj(t, fmt.Sprintf(`{"name":%q,"urls":{"chat":"https://%s.example.com/v1"},`+
			`"newKeys":[{"value":"sk-%s-1234567890"}],"models":[{"id":%q,"enabled":true}]}`, id, id, id, m))
		if _, err := s.UpsertProvider(in); err != nil {
			t.Fatal(err)
		}
	}
	setMain := func(id string) {
		if err := s.SetAssignment("nomi", mustObj(t, fmt.Sprintf(`{"models":{"main":"%s/%s"}}`, id, pair[id]))); err != nil {
			t.Error(err)
		}
	}
	setMain("pa")

	const rounds = 100
	start := make(chan struct{}) // 屏障：读写同时放行，最大化交错
	var wg sync.WaitGroup
	writer := func(f func(i int)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for i := range rounds {
				f(i)
			}
		}()
	}
	reader := func(f func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for range rounds {
				f()
			}
		}()
	}
	writer(func(i int) {
		if i%2 == 0 {
			setMain("pb")
		} else {
			setMain("pa")
		}
	})
	writer(func(int) {
		if err := s.ResetToken("nomi"); err != nil {
			t.Error(err)
		}
	})
	writer(func(i int) {
		if err := s.SetAssignment("claude", mustObj(t, fmt.Sprintf(`{"models":{"main":"pa/ma","small":"x%d"}}`, i))); err != nil {
			t.Error(err)
		}
	})
	writer(func(i int) {
		in := mustObj(t, fmt.Sprintf(`{"id":"pb","name":"pb %d","urls":{"chat":"https://pb.example.com/v1"},`+
			`"models":[{"id":"mb","enabled":true}]}`, i%3))
		if _, err := s.UpsertProvider(in); err != nil {
			t.Error(err)
		}
	})
	reader(func() {
		// 同一次读取：供应商与模型必须来自同一个版本，不混合新旧分配
		p := s.NomiProvider("chat")
		if p == nil {
			t.Error("NomiProvider = nil")
			return
		}
		id, _ := p.Get("id").(string)
		if m, _ := p.Get("model").(string); pair[id] != m {
			t.Errorf("mixed snapshot: provider %q model %q", id, m)
		}
	})
	reader(func() {
		if c := s.NomiContext("agent-tools"); c == nil {
			t.Error("NomiContext = nil")
		}
	})
	reader(func() {
		if ep := s.Endpoint("nomi"); ep == nil || ep.Token == "" {
			t.Error("Endpoint without token")
		}
		_ = s.NomiRoute("summary")
	})
	reader(func() {
		_ = s.CliDefaults("claude")
		_ = s.CliModels()
		_ = s.Credentials("pa")
		_ = s.ListOpenAiCompatible()
		_ = s.ProviderInfo("pb")
		_ = s.HelperRoute("claude", "")
		_ = s.OfficialEnv(u.NewObj())
	})
	reader(func() {
		_ = s.RuntimeConfig()
		_ = s.State()
		_ = s.PreviewPrivacy("hello sk-pa-1234567890")
	})
	close(start)
	wg.Wait()

	// 写完之后锁外读到的就是最新提交的版本
	setMain("pb")
	if p := s.NomiProvider("chat"); p == nil || p.Get("id") != "pb" {
		t.Fatalf("after write: %v", p)
	}
}
