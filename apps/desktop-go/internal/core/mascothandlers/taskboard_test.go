package mascothandlers

import (
	"context"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

// window.openTaskBoard = openProviderPanel('nav.scheduleRequested')：只发给 chat 面
func TestOpenTaskBoard(t *testing.T) {
	r := contract.NewRouter()
	opened := 0
	Install(Deps{Router: r, OpenChat: func() { opened++ }})
	evs := map[string][]string{}
	res := make(chan contract.ServerFrame, 4)
	for _, sf := range []string{"chat", "mascot"} {
		sf := sf
		s := r.NewSession(context.Background(), contract.Caller{Surface: sf}, func(f contract.ServerFrame) {
			if f.T == "event" {
				evs[sf] = append(evs[sf], f.Event)
			} else if f.ID == "x" {
				res <- f
			}
		})
		t.Cleanup(s.Close)
		s.Handle([]byte(`{"t":"sub","event":"nav.scheduleRequested"}`))
		s.Handle([]byte(`{"t":"sub","event":"nav.desktopPanelRequested"}`))
		if sf == "mascot" {
			s.Handle([]byte(`{"t":"req","id":"x","kind":"call","name":"window.openTaskBoard","input":null}`))
		}
	}
	select {
	case f := <-res:
		if f.Error != nil {
			t.Fatalf("%+v", f.Error)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
	if opened != 1 || len(evs["chat"]) != 1 || evs["chat"][0] != "nav.scheduleRequested" || len(evs["mascot"]) != 0 {
		t.Fatalf("opened=%d evs=%v", opened, evs)
	}
}
