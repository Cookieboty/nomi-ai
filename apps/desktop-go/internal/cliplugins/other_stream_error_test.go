package cliplugins_test

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestDshAndGrokExtractNestedStreamErrors(t *testing.T) {
	dshEvs := dsh.ParseLine(`{"type":"error","error":{"message":"503 Service Unavailable"}}`)
	if len(dshEvs) != 1 || util.Str(dshEvs[0].Get("message")) != "503 Service Unavailable" {
		t.Fatalf("dsh nested error not extracted: %v", dshEvs)
	}
	grokEvs := grok.ParseLine(`{"type":"error","error":{"message":"rate limit exceeded"}}`)
	if len(grokEvs) != 1 || util.Str(grokEvs[0].Get("message")) != "rate limit exceeded" {
		t.Fatalf("grok nested error not extracted: %v", grokEvs)
	}
}
