package media

import "testing"

func relayP(id string, models []string, gemini bool) AutoProvider {
	urls := map[string]string{"chat": "https://" + id + ".example/v1"}
	if gemini {
		urls["gemini"] = "https://" + id + ".example/v1beta"
	}
	return AutoProvider{Info: ProviderInfo{ID: id, URLs: urls}, Models: models}
}

func TestAutoImageModel(t *testing.T) {
	amux := relayP("amux", []string{"openai/gpt-6-astra", "google/gemini-3-pro", "openai/gpt-image-2",
		"openai/gpt-image-2.5-flare", "google/gemini-3-pro-image", "anthropic/claude-fable-5"}, true)
	cases := []struct{ main, want string }{
		{"amux/openai/gpt-6-astra", "amux/openai/gpt-image-2.5-flare"},
		{"amux/google/gemini-3-pro", "amux/google/gemini-3-pro-image"},
		{"amux/anthropic/claude-fable-5", "amux/openai/gpt-image-2.5-flare"},
		{"", "amux/openai/gpt-image-2.5-flare"},
	}
	for _, c := range cases {
		if got := AutoImageModel(c.main, []AutoProvider{amux}); got != c.want {
			t.Fatalf("%s → %s, want %s", c.main, got, c.want)
		}
	}
	if got := AutoImageModel("g/claude-x", []AutoProvider{relayP("g", []string{"claude-x", "gemini-2.5-flash-image"}, true)}); got != "g/gemini-2.5-flash-image" {
		t.Fatal(got)
	}
	a, b, c := relayP("a", []string{"gpt-6-sol"}, false), relayP("b", []string{"gpt-image-2"}, false), relayP("c", []string{"gpt-image-1"}, false)
	if got := AutoImageModel("a/gpt-6-sol", []AutoProvider{a, c, b}); got != "c/gpt-image-1" {
		t.Fatal(got)
	}
	own := relayP("a", []string{"gpt-6-sol", "gpt-image-1"}, false)
	if got := AutoImageModel("a/gpt-6-sol", []AutoProvider{b, own}); got != "a/gpt-image-1" {
		t.Fatal(got)
	}
	if AutoImageModel("x/gpt-6", []AutoProvider{relayP("x", []string{"gpt-6-sol"}, false)}) != "" {
		t.Fatal("no image model")
	}
	if AutoImageModel("n/gpt-6", []AutoProvider{{Info: ProviderInfo{ID: "n", URLs: map[string]string{}}, Models: []string{"gpt-image-2"}}}) != "" {
		t.Fatal("no endpoint")
	}
	for _, id := range []string{"gpt-image-2", "dall-e-3", "gemini-2.5-flash-image", "doubao-seedream-4-0", "qwen-image"} {
		if !IsImageModelID(id) {
			t.Fatal(id)
		}
	}
	for _, id := range []string{"gpt-6-astra", "gemini-3-flash-preview", "imagine-chat"} {
		if IsImageModelID(id) {
			t.Fatal(id)
		}
	}
}
