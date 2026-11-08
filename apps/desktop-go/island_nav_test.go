package main

import "testing"

// 灵动岛条目 → 对话窗口里的去处
func TestIslandNavOf(t *testing.T) {
	for id, want := range map[string][2]string{
		"perm\x1ftab_3\x1freq9": {"tab", "tab_3"},
		"sbx\x1ftab_1\x1fs2":    {"tab", "tab_1"},
		"task\x1ftk_7":          {"task", "tk_7"},
		"confirm\x1fc1":         {"nomi", ""},
	} {
		if tg, ref := islandNavOf(id); tg != want[0] || ref != want[1] {
			t.Errorf("%q → %s %s", id, tg, ref)
		}
	}
}
