package memory

import (
	"slices"
	"testing"
)

func TestIsDuplicateFactNearlySame(t *testing.T) {
	yes := [][2]string{
		{"用户被助手称呼为「言哥」", "用户被助手称为「言哥」"},
		{"用户被称呼为言哥", "用户被助手称呼为言哥"},
		{"用户叫言哥", "用户叫言哥。"},
		{"用户在做 Nomi 项目", "用户在做 Nomi 项目，用 Go 重写"},
	}
	no := [][2]string{
		{"用户喜欢养猫", "用户喜欢养狗"},
		{"用户住在北京", "用户住在上海"},
		{"用户的生日是5月1日", "用户的生日是6月1日"},
		{"用户不喜欢吃香菜", "用户喜欢吃香菜"},
		{"用户在做项目", "用户在北京的公司做一个项目"},
		{"喜欢猫", "喜欢狗"},
		// 多出来的是数字 / 中文数字 / 字母：不同项目、不同数值（#223）
		{"用户项目A预算是10万元", "用户项目AB预算是100万元"},
		{"用户的项目代号是Atls计划", "用户的项目代号是Atlas计划"},
		{"用户每周跑步三次左右", "用户每周跑步三十次左右"},
		{"用户喜欢早上喝咖啡", "用户not喜欢早上喝咖啡"},
	}
	for _, c := range yes {
		if !IsDuplicateFact(c[0], c[1]) {
			t.Fatalf("应视为重复：%v", c)
		}
	}
	for _, c := range no {
		if IsDuplicateFact(c[0], c[1]) {
			t.Fatalf("不应视为重复：%v", c)
		}
	}
}

func TestDedupeFacts(t *testing.T) {
	f := func(id, text, source string, at int64) Fact {
		return Fact{ID: id, Text: text, Source: source, UpdatedAt: at}
	}
	kept, dropped := DedupeFacts([]Fact{
		f("a", "用户被助手称呼为「言哥」", "distilled", 1),
		f("b", "用户被助手称为「言哥」", "distilled", 2),
		f("c", "用户喜欢养猫", "distilled", 1),
		f("d", "用户被称呼为言哥", "user", 0),
	})
	ids := []string{}
	for _, k := range kept {
		ids = append(ids, k.ID)
	}
	slices.Sort(dropped)
	if !slices.Equal(ids, []string{"c", "d"}) || !slices.Equal(dropped, []string{"a", "b"}) {
		t.Fatalf("kept=%v dropped=%v", ids, dropped)
	}
}

func TestDedupeFactsKeepsDifferentProjects(t *testing.T) {
	kept, dropped := DedupeFacts([]Fact{
		{ID: "a", Text: "用户项目A预算是10万元", Source: "user", UpdatedAt: 1},
		{ID: "b", Text: "用户项目AB预算是100万元", Source: "user", UpdatedAt: 2},
	})
	if len(kept) != 2 || len(dropped) != 0 {
		t.Fatalf("kept=%v dropped=%v", kept, dropped)
	}
}
