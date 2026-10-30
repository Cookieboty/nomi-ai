package contract

import (
	"context"
	"encoding/json"
	"testing"
)

func TestHandlerPanicBecomesInternalError(t *testing.T) {
	r := NewRouter()
	r.Call("x.boom", func(context.Context, Caller, json.RawMessage) (any, error) { panic("boom") })
	ch := make(chan ServerFrame, 1)
	s := r.NewSession(context.Background(), Caller{Surface: "chat"}, func(f ServerFrame) { ch <- f })
	defer s.Close()
	b, _ := json.Marshal(ClientFrame{T: "req", ID: "1", Kind: "call", Name: "x.boom"})
	s.Handle(b)
	f := <-ch
	if f.T != "err" || f.Error.Code != "INTERNAL" || f.Error.Message != "boom" {
		t.Fatalf("got %+v", f)
	}
}
