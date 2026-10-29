package shellhandlers_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/procs"
)

func TestProvidersHandlersReplaceStub(t *testing.T) {
	r := contract.NewRouter()
	svc := shellhandlers.NewProviderService(nil, map[string]string{"OPENAI_API_KEY": "sk-test"}, nil)
	shellhandlers.InstallProviders(r, svc)
	procs.Install(r)
	ch := make(chan contract.ServerFrame, 16)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()
	call := func(id, name, input string) contract.ServerFrame {
		s.Handle([]byte(`{"t":"req","id":"` + id + `","kind":"call","name":"` + name + `","input":` + input + `}`))
		for {
			select {
			case f := <-ch:
				if f.ID == id {
					return f
				}
			case <-time.After(2 * time.Second):
				t.Fatal("timeout " + name)
			}
		}
	}
	for i, n := range []string{"providers.presets", "providers.meta", "providers.state"} {
		f := call(string(rune('a'+i)), n, "null")
		if f.T != "res" {
			t.Fatalf("%s: %+v %+v", n, f, f.Error)
		}
	}
	b, _ := json.Marshal(call("s", "providers.state", "null").Output)
	if !strings.Contains(string(b), "（环境变量）") {
		t.Fatalf("env provider missing: %s", b)
	}
	f := call("x", "providers.setActive", `{"id":"nope-sk-ABCDEFGHIJKLMNOP"}`)
	if f.T != "err" || f.Error == nil || strings.Contains(f.Error.Message, "ABCDEFGHIJKLMNOP") {
		t.Fatalf("want redacted err: %+v %+v", f, f.Error)
	}
}
