// Package catalog：内置编程助手的清单。只在 packages/cli-catalog/src/<id>/manifest.ts 写一份，
// 生成到这里的 catalog.json（pnpm -F @nomi-ai/cli-catalog gen:go；那边的测试会查它是否最新）。
// 这个包只放数据，插件包与注册表（builtin）都从这里取。
package catalog

import (
	_ "embed"
	"slices"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

//go:embed catalog.json
var raw []byte

var data = func() *util.Obj {
	v, err := util.Parse(raw)
	if err != nil {
		panic("cliplugins/catalog: catalog.json: " + err.Error())
	}
	return v.(*util.Obj)
}()

// Order：界面与名单的顺序（cli-catalog 的 BUILTIN_CLI_ORDER）
var Order = func() []string {
	out := []string{}
	for _, x := range data.Get("order").([]any) {
		out = append(out, x.(string))
	}
	return out
}()

// IDs：全部内置 id，按 id 排序（与 cli-catalog 的 BUILTIN_CLI_IDS 一致）
var IDs = func() []string {
	ids := slices.Clone(data.Get("manifests").(*util.Obj).Keys())
	slices.Sort(ids)
	return ids
}()

// Manifest：id 的清单（同一个对象，调用方要改时先 Clone）；不是内置的返回 nil
func Manifest(id string) *util.Obj {
	m, _ := data.Get("manifests").(*util.Obj).Get(id).(*util.Obj)
	return m
}

// Host：清单 host 段（内核运行它要知道的事）；没有返回空对象
func Host(id string) *util.Obj {
	if m := Manifest(id); m != nil {
		if h, ok := m.Get("host").(*util.Obj); ok {
			return h
		}
	}
	return util.NewObj()
}

// HostList：清单 host 段里的字符串数组（homeDirs、execConfig、acpArgs）；没有的返回空
func HostList(id, key string) []string {
	out := []string{}
	if a, ok := Host(id).Get(key).([]any); ok {
		for _, x := range a {
			out = append(out, util.Str(x))
		}
	}
	return out
}

// HostListAll：所有内置 CLI 的 HostList 拼在一起（按 Order）
func HostListAll(key string) []string {
	out := []string{}
	for _, id := range Order {
		out = append(out, HostList(id, key)...)
	}
	return out
}
