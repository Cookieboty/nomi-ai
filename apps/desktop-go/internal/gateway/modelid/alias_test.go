package modelid

import (
	"strings"
	"testing"
)

func TestCanonicalAndMismatch(t *testing.T) {
	same := [][2]string{
		{"openai/gpt-4o", "gpt-4o"},
		{"openai-2/gpt-4o", "gpt-4o"},
		{"gpt-4o", "gpt-4o-2024-08-06"},
		{"claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022"},
		{"claude-sonnet-4-5", "anthropic/claude-sonnet-4-5-20250929"},
		{"MAAS/Aerith-fable-5", "aerith-fable-5"},
		{"maas/Aerith-fable-5", "Aerith-fable-5"},
		{"claude-opus-4.1", "claude-opus-4-1"},
		{"models/gemini-2.5-pro", "gemini-2.5-pro"},
		{"publishers/google/models/gemini-2.5-pro", "gemini-2.5-pro"},
		{"GPT-4o", "  gpt-4o  "},
		{"gpt_4o", "gpt-4o"},
		{"o3", "o3-2025-04-16"},
	}
	for _, c := range same {
		if got := Mismatch([]string{c[0]}, c[1]); got != "" {
			t.Errorf("Mismatch(%q, %q) = %q, want same", c[0], c[1], got)
		}
	}
	diff := [][2]string{
		{"Aerith-fable-5", "claude-fable-5"},
		{"maas/Aerith-fable-5", "claude-opus-4-5"},
		{"gpt-4o", "gpt-4o-mini"},
		{"gemini-2.5-pro", "gemini-2.0-flash"},
		{"claude-3-5-sonnet", "claude-3-opus"},
		{"o3", "o3-mini"},
	}
	for _, c := range diff {
		if got := Mismatch([]string{c[0]}, c[1]); got != c[1] {
			t.Errorf("Mismatch(%q, %q) = %q, want %q", c[0], c[1], got, c[1])
		}
	}
	if Mismatch(nil, "gpt-4o") != "" {
		t.Fatal("no requested name is not a mismatch")
	}
	if Mismatch([]string{"gpt-4o"}, "  ") != "" {
		t.Fatal("empty return")
	}
	if Mismatch([]string{"openai/gpt-4o", "gpt-4o"}, "gpt-4o-2024-08-06") != "" {
		t.Fatal("any requested alias should suppress")
	}
	long := strings.Repeat("m", 250)
	got := Mismatch([]string{"other"}, long)
	if len(got) != 200 {
		t.Fatalf("clip len %d", len(got))
	}
}

func TestRegistryLatest(t *testing.T) {
	key := TabKey("registry-test")
	Note(key, Sample{Response: "first", Requested: []string{"asked"}, At: 1})
	Note(key, Sample{Response: "second", Requested: []string{"asked"}, At: 2})
	Note(key, Sample{Response: "  ", At: 3})
	s, ok := Latest(key)
	if !ok || s.Response != "second" || s.At != 2 {
		t.Fatalf("%+v %v", s, ok)
	}
	if _, ok := Latest(TabKey("missing")); ok {
		t.Fatal("missing")
	}
}
