package shellhandlers_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/procs"
)

func TestThemeHandlersReplaceStub(t *testing.T) {
	dir := t.TempDir()
	r := contract.NewRouter()
	shellhandlers.Install(shellhandlers.Deps{
		UserData: dir, Router: r, SystemLangs: []string{"zh-CN"},
	})
	procs.Install(r)
	ch := make(chan contract.ServerFrame, 8)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()
	s.Handle([]byte(`{"t":"req","id":"1","kind":"call","name":"theme.get"}`))
	select {
	case f := <-ch:
		if f.T != "res" {
			t.Fatalf("%+v", f)
		}
		var st struct {
			Pref string `json:"pref"`
		}
		b, _ := json.Marshal(f.Output)
		_ = json.Unmarshal(b, &st)
		if st.Pref == "" {
			t.Fatalf("%+v", f.Output)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}
