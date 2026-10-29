package shellhandlers_test

import (
	"context"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
)

func sessionCall(t *testing.T, r *contract.Router, surface string) (func(id, name, input string) contract.ServerFrame, chan contract.ServerFrame) {
	ch := make(chan contract.ServerFrame, 32)
	s := r.NewSession(context.Background(), contract.Caller{Surface: surface}, func(f contract.ServerFrame) { ch <- f })
	t.Cleanup(s.Close)
	return func(id, name, input string) contract.ServerFrame {
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
	}, ch
}

func TestTerminalUnavailable(t *testing.T) {
	r := contract.NewRouter()
	shellhandlers.InstallGateway(r, nil)
	shellhandlers.InstallTerminal(r, nil)
	call, _ := sessionCall(t, r, "chat")
	for i, n := range []string{"gateway.detect", "gateway.terminalState", "gateway.terminalSet"} {
		f := call(string(rune('a'+i)), n, `{"enabled":true}`)
		want := "Service 'gateway' is not available"
		if n != "gateway.detect" {
			want = "Service 'terminal' is not available"
		}
		if f.Error == nil || f.Error.Code != "UNAVAILABLE" || f.Error.Message != want {
			t.Errorf("%s: %+v", n, f.Error)
		}
	}
	reg := r.Registered()
	for _, n := range shellhandlers.GatewayProcedures {
		if _, ok := reg[n]; !ok {
			t.Errorf("%s not registered", n)
		}
	}
}

func TestWindowRoutes(t *testing.T) {
	want := map[string]string{"providers": "providers.openPanel", "desktop": "nav.desktopPanelRequested",
		"schedule": "nav.scheduleRequested", "voice": "nav.voiceSettingsRequested"}
	if len(shellhandlers.WindowRoutes) != len(want) {
		t.Fatalf("routes %v", shellhandlers.WindowRoutes)
	}
	for k, v := range want {
		if shellhandlers.WindowRoutes[k] != v {
			t.Errorf("route %s = %q want %q", k, shellhandlers.WindowRoutes[k], v)
		}
	}
	r := contract.NewRouter()
	opened := 0
	if r.EmitTo("providers.openPanel", map[string]any{}, "chat") {
		t.Fatal("no subscribers yet")
	}
	shellhandlers.OpenRoute(r, func() { opened++ }, "providers")
	shellhandlers.OpenRoute(r, func() { opened++ }, "unknown")
	shellhandlers.OpenProviderPanel(r, func() { opened++ }, "")
	if opened != 3 {
		t.Errorf("openChat calls %d", opened)
	}
}
