package gwstore

import (
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestServiceDetectForwardsSessionHeader(t *testing.T) {
	dir := t.TempDir()
	var captured []*u.Obj
	port := 0
	s := NewServiceForUserData(dir, fakeCipher{}, nil)
	s.Store.SetPresetDeps(FindPresetDeps())
	s.AttachRuntime(RuntimeDeps{
		Root: dir,
		Lazy: true,
		Port: &port,
		Env:  map[string]string{},
		Detect: func(in *u.Obj) (*u.Obj, error) {
			captured = append(captured, in)
			return u.NewObj("wires", u.NewObj(), "byKey", u.NewObj(), "models", []any{}, "urls", in.Get("bases")), nil
		},
	})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	defer s.Dispose()

	// 1. 新建供应商时按 presetId 从预设读取 quirks.sessionHeader，并启用 requireInferenceOK
	if _, err := s.Detect(u.NewObj(
		"presetId", "opencode-go",
		"urls", u.NewObj("chat", "https://opencode.ai/inference/go/openai/v1"),
		"keys", []any{"sk-test"},
	)); err != nil {
		t.Fatal(err)
	}
	if len(captured) != 1 || captured[0].Get("sessionHeader") != "x-opencode-session" || captured[0].Get("requireInferenceOK") != true {
		t.Fatalf("presetId detect did not forward sessionHeader + requireInferenceOK: %s", u.Stringify(captured))
	}

	// 2. 无 sessionHeader 的预设不传这两个字段
	if _, err := s.Detect(u.NewObj(
		"presetId", "openrouter",
		"urls", u.NewObj("chat", "https://openrouter.ai/api/v1"),
		"keys", []any{"sk-test"},
	)); err != nil {
		t.Fatal(err)
	}
	if len(captured) != 2 || captured[1].Has("sessionHeader") || captured[1].Has("requireInferenceOK") {
		t.Fatalf("openrouter detect should not forward sessionHeader/requireInferenceOK: %s", u.Stringify(captured[1]))
	}

	// 3. 已保存供应商（即便旧记录未拷贝 quirks，仅存 presetId）重新检测时也应补出 sessionHeader 与 requireInferenceOK
	saved, err := s.UpsertProvider(u.NewObj(
		"name", "OpenCode Go",
		"presetId", "opencode-go",
		"urls", u.NewObj("chat", "https://opencode.ai/inference/go/openai/v1"),
		"newKeys", []any{u.NewObj("value", "sk-saved")},
		"models", []any{u.NewObj("id", "kimi-k3", "enabled", true)},
	))
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := saved.Get("id").(string)
	if _, err := s.Detect(u.NewObj("providerId", pid)); err != nil {
		t.Fatal(err)
	}
	if len(captured) != 3 || captured[2].Get("sessionHeader") != "x-opencode-session" || captured[2].Get("requireInferenceOK") != true {
		t.Fatalf("saved provider detect did not forward sessionHeader + requireInferenceOK: %s", u.Stringify(captured))
	}

	// 4. 调用方直接传入裸 sessionHeader（无匹配预设/已保存 quirks）时必须忽略
	if _, err := s.Detect(u.NewObj(
		"url", "https://custom.example.test/v1",
		"keys", []any{"sk-test"},
		"sessionHeader", "x-injected",
	)); err != nil {
		t.Fatal(err)
	}
	if len(captured) != 4 || captured[3].Has("sessionHeader") || captured[3].Has("requireInferenceOK") {
		t.Fatalf("raw input sessionHeader must be ignored: %s", u.Stringify(captured[3]))
	}
}
