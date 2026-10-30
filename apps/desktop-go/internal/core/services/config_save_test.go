package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// #182：两个并发 UpdateConfig，先取快照的保存被卡在写入前，后一个更新已在内存生效。
// 保存全程串行后，旧快照不能最后落盘，文件里必须是最新组合状态。
func TestConfigConcurrentSavesLatestWins(t *testing.T) {
	dir := t.TempDir()
	c := NewConfig(dir)

	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	orig := writeConfigFile
	writeConfigFile = func(path string, data []byte) error {
		first := false
		once.Do(func() { first = true })
		if first {
			close(entered)
			<-release
		}
		return orig(path, data)
	}
	t.Cleanup(func() { writeConfigFile = orig })

	var wg sync.WaitGroup
	errs := make([]error, 2)
	wg.Add(1)
	go func() { defer wg.Done(); errs[0] = c.UpdateConfig(map[string]any{"mascotScale": 0.7}) }()
	<-entered // A 已取快照（只含 0.7），停在写入前

	wg.Add(1)
	go func() { defer wg.Done(); errs[1] = c.UpdateConfig(map[string]any{"debug": true}) }()
	deadline := time.Now().Add(5 * time.Second)
	for !c.GetConfig().Debug { // B 的更新已在内存生效（其保存应排在 A 之后）
		if time.Now().After(deadline) {
			t.Fatal("B 的更新未生效")
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("save %d: %v", i, err)
		}
	}

	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var onDisk AppConfig
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("配置文件不是完整 JSON: %v\n%s", err, raw)
	}
	if onDisk.MascotScale != 0.7 || !onDisk.Debug {
		t.Fatalf("旧快照覆盖了最新更新: %+v", onDisk)
	}
	if got := NewConfig(dir).GetConfig(); got.MascotScale != 0.7 || !got.Debug {
		t.Fatalf("重读 %+v", got)
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.Contains(e.Name(), ".tmp") {
			t.Fatalf("临时文件残留: %s", e.Name())
		}
	}
}

// 写入失败要如实报错，且原完整文件保持可用
func TestConfigSaveFailureKeepsFile(t *testing.T) {
	dir := t.TempDir()
	c := NewConfig(dir)
	if err := c.UpdateConfig(map[string]any{"mascotScale": 0.9}); err != nil {
		t.Fatal(err)
	}
	orig := writeConfigFile
	writeConfigFile = func(string, []byte) error { return os.ErrPermission }
	t.Cleanup(func() { writeConfigFile = orig })
	if err := c.UpdateConfig(map[string]any{"mascotScale": 0.3}); err == nil {
		t.Fatal("写入失败应返回错误")
	}
	if got := NewConfig(dir).GetConfig(); got.MascotScale != 0.9 {
		t.Fatalf("原文件应保持 0.9: %+v", got)
	}
}
