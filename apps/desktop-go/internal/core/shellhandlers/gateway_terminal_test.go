package shellhandlers_test

import (
	"context"
	"strings"
	"sync"
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
	got := map[string][]string{}
	var mu sync.Mutex
	for _, sf := range []string{"chat", "mascot", "settings"} {
		sf := sf
		s := r.NewSession(context.Background(), contract.Caller{Surface: sf}, func(f contract.ServerFrame) {
			if f.T == "event" {
				mu.Lock()
				got[sf] = append(got[sf], f.Event)
				mu.Unlock()
			}
		})
		t.Cleanup(s.Close)
		for _, ev := range []string{"providers.openPanel", "nav.desktopPanelRequested", "nav.scheduleRequested", "nav.voiceSettingsRequested"} {
			s.Handle([]byte(`{"t":"sub","event":"` + ev + `"}`))
		}
	}
	opened := 0
	shellhandlers.OpenRoute(r, func() { opened++ }, "providers")
	shellhandlers.OpenRoute(r, func() { opened++ }, "unknown")
	shellhandlers.OpenRoute(r, func() { opened++ }, "voice")
	shellhandlers.OpenProviderPanel(r, func() { opened++ }, "")
	shellhandlers.OpenProviderPanel(r, func() { opened++ }, "nav.scheduleRequested")
	if opened != 5 {
		t.Errorf("openChat calls %d", opened)
	}
	mu.Lock()
	defer mu.Unlock()
	wantChat := []string{"providers.openPanel", "nav.voiceSettingsRequested", "providers.openPanel", "nav.scheduleRequested"}
	if strings.Join(got["chat"], ",") != strings.Join(wantChat, ",") {
		t.Errorf("chat got %v want %v", got["chat"], wantChat)
	}
	if len(got["mascot"])+len(got["settings"]) != 0 {
		t.Errorf("leaked to other surfaces: %v", got)
	}
}
