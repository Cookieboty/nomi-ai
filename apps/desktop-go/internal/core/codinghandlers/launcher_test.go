package codinghandlers

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
)

func TestCliLauncherSetBroadcastsToChatSurface(t *testing.T) {
	cli.ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { cli.ConfigureLaunchers("") })

	r := contract.NewRouter()
	RegisterCoding(r, CodingServices{})

	chatFrames := make(chan contract.ServerFrame, 8)
	mascotFrames := make(chan contract.ServerFrame, 8)

	chatSession := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(fr contract.ServerFrame) {
		chatFrames <- fr
	})
	defer chatSession.Close()

	mascotSession := r.NewSession(context.Background(), contract.Caller{Surface: "mascot"}, func(fr contract.ServerFrame) {
		mascotFrames <- fr
	})
	defer mascotSession.Close()

	subBytes, _ := json.Marshal(contract.ClientFrame{T: "sub", Event: "cli.launcherChanged"})
	chatSession.Handle(subBytes)
	mascotSession.Handle(subBytes)

	in, _ := json.Marshal(map[string]any{
		"kind": "claude",
		"settings": map[string]any{
			"enabled":       false,
			"command":       "",
			"accountSource": "local",
		},
	})
	callBytes, _ := json.Marshal(contract.ClientFrame{T: "req", ID: "1", Kind: "call", Name: "cli.launcherSet", Input: in})
	chatSession.Handle(callBytes)

	var gotRes, gotEvt bool
	for !(gotRes && gotEvt) {
		var fr contract.ServerFrame
		select {
		case fr = <-chatFrames:
		case <-time.After(3 * time.Second):
			t.Fatalf("timed out waiting for frames (gotRes=%v, gotEvt=%v)", gotRes, gotEvt)
		}
		switch fr.T {
		case "res":
			gotRes = true
		case "err":
			t.Fatalf("unexpected error frame: %+v", fr.Error)
		case "event":
			if fr.Event != "cli.launcherChanged" {
				t.Fatalf("unexpected event %q", fr.Event)
			}
			gotEvt = true
			raw, _ := json.Marshal(fr.Data)
			var payload map[string]cli.LauncherView
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatalf("decode event payload: %v", err)
			}
			if payload["claude"].AccountSource != "local" {
				t.Fatalf("expected claude accountSource=local in event, got %+v", payload["claude"])
			}
		default:
			t.Fatalf("unexpected frame %+v", fr)
		}
	}

	select {
	case unexpected := <-mascotFrames:
		t.Fatalf("mascot should not receive cli.launcherChanged, got %+v", unexpected)
	default:
	}
}
