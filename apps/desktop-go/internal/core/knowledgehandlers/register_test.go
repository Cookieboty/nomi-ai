package knowledgehandlers

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledge"
)

func TestHandlersCover75(t *testing.T) {
	h := Handlers(Services{})
	if len(h) != 75 {
		t.Fatalf("got %d handlers, want 75", len(h))
	}
	for n := range h {
		p := strings.SplitN(n, ".", 2)[0]
		switch p {
		case "kb", "mem", "sched", "local", "hub", "ext":
		default:
			t.Errorf("unexpected namespace %s", n)
		}
	}
}

func TestNeedUnavailable(t *testing.T) {
	h := Handlers(Services{})
	_, err := h["kb.state"](context.Background(), []byte(`{}`))
	var ce *contract.Error
	if !errors.As(err, &ce) || ce.Code != "UNAVAILABLE" || ce.Message != "Service 'kb' is not available" {
		t.Fatalf("got %v", err)
	}
}

func TestErrorCodeMapping(t *testing.T) {
	if got := ErrorCode("KB", &knowledge.KbError{Code: "local_only"}); got != "KB_LOCAL_ONLY" {
		t.Fatal(got)
	}
	if got := ErrorCode("KB", &knowledge.KbError{Code: "weird"}); got == "KB_WEIRD" {
		t.Fatal("undeclared code must not map")
	}
}
