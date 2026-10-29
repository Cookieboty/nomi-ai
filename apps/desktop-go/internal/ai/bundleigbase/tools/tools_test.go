package tools

import "testing"

func TestInMemoryMapSemantics(t *testing.T) {
	r := NewInMemory()
	r.Register(Definition{Name: "a", Description: "1"})
	r.Register(Definition{Name: "b"})
	r.Register(Definition{Name: "a", Description: "2"})
	l := r.List()
	if len(l) != 2 || l[0].Name != "a" || l[0].Description != "2" || l[1].Name != "b" {
		t.Fatalf("%+v", l)
	}
	if !r.Unregister("a") || r.Unregister("a") {
		t.Fatal("unregister")
	}
	r.Register(Definition{Name: "w", RequiresWorkspace: true})
	if len(ForLoop(r, "")) != 1 || len(ForLoop(r, "/x")) != 2 {
		t.Fatal("requiresWorkspace")
	}
	if SchemaOf(Definition{}).Get("additionalProperties") != true {
		t.Fatal("schema")
	}
}
