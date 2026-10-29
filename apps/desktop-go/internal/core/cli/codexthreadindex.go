package cli

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// codexThreadCols = COLS（历史列表用到的列，顺序即 SELECT 顺序）。
var codexThreadCols = []string{"id", "source", "originator", "model_provider", "cwd", "title", "name",
	"first_user_message", "model", "reasoning_effort", "creator_account_id", "archived"}

// ReadCodexThreads = readCodexThreads：只读打开 state_5.sqlite，按表结构只选存在的列；无 id 列 / 出错返回空。
// 行为 node:sqlite 的 .all()：列名为键，INTEGER/REAL → number，TEXT → string，NULL → null。
func ReadCodexThreads(file string) []*util.Obj {
	// Node 用同一个只读连接执行两条语句；这里分两次只读打开，结果相同（只读、无写入）
	names := usage.SelectRows(file, `SELECT name FROM pragma_table_info('threads')`)
	cols := []string{}
	for _, r := range names {
		n, _ := r.Get("name").(string)
		for _, c := range codexThreadCols {
			if c == n {
				cols = append(cols, n)
				break
			}
		}
	}
	has := false
	for _, c := range cols {
		if c == "id" {
			has = true
		}
	}
	if !has {
		return []*util.Obj{}
	}
	return usage.SelectRows(file, `SELECT `+strings.Join(cols, ", ")+` FROM threads`)
}
