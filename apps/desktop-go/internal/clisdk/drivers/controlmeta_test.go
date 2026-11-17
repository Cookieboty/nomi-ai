package drivers

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func TestStreamJsonObservesInitializeMetadataWithoutWaiting(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		var responses []*util.Obj
		d := NewStreamJsonDriver(StreamJsonDriverOptions{
			Child: child, ParseLine: func(string) []Ev { return nil },
			OnControlResponse: func(response *util.Obj) { responses = append(responses, response) },
		})
		d.NotifyControl(O("subtype", "initialize"))
		request := child.messages()[0]
		child.send(O("type", "control_response", "response", O("subtype", "success", "request_id", request.Get("request_id"),
			"response", O("user_output_styles_dir", "launcher-config/output-styles"))))
		if len(responses) != 1 || responses[0].Get("user_output_styles_dir") != "launcher-config/output-styles" {
			t.Fatal("fire-and-forget initialize metadata was discarded")
		}
		p := d.Control(O("subtype", "set_model", "model", "sonnet"))
		request = child.messages()[1]
		child.send(O("type", "control_response", "response", O("subtype", "success", "request_id", request.Get("request_id"), "response", O("ok", true))))
		if response, err := jsrt.Await(p); err != nil || response.Get("ok") != true {
			t.Fatal("metadata observer broke a pending control response", err)
		}
		child.send(O("type", "control_response", "response", O("subtype", "error", "response", O("user_output_styles_dir", "bad"))))
		if len(responses) != 2 {
			t.Fatal("failed response was treated as configuration metadata")
		}
	})
}
