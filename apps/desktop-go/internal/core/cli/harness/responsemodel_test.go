package harness

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/modelid"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestNoteResponseModel(t *testing.T) {
	modelid.Note(modelid.TabKey("rm-diff"), modelid.Sample{
		Response: "claude-fable-5", Requested: []string{"maas/Aerith-fable-5", "Aerith-fable-5"}, At: 1000,
	})
	msg := util.NewObj("model", "maas/Aerith-fable-5")
	noteResponseModel(msg, "rm-diff", 500)
	if msg.Get("responseModel") != "claude-fable-5" {
		t.Fatalf("diff: %v", msg.Get("responseModel"))
	}

	modelid.Note(modelid.TabKey("rm-alias"), modelid.Sample{
		Response: "gpt-4o-2024-08-06", Requested: []string{"openai/gpt-4o"}, At: 1000,
	})
	alias := util.NewObj("model", "openai/gpt-4o")
	noteResponseModel(alias, "rm-alias", 500)
	if alias.Has("responseModel") {
		t.Fatal("date suffix should not be shown")
	}

	stale := util.NewObj("model", "maas/Aerith-fable-5")
	noteResponseModel(stale, "rm-diff", 5000)
	if stale.Has("responseModel") {
		t.Fatal("sample from before this turn")
	}
}
