package usage

import (
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strconv"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	_ "modernc.org/sqlite"
)

// DBBatch = DB_BATCH。
const DBBatch = 20_000

// sqliteURI：只读打开（node:sqlite { readOnly: true } = SQLITE_OPEN_READONLY，不创建文件）。
func sqliteURI(file string) string {
	p := filepath.ToSlash(file)
	if len(p) > 1 && p[1] == ':' {
		p = "/" + p
	}
	return "file:" + (&url.URL{Path: p}).EscapedPath() + "?mode=ro"
}

func selectRows(file, q string, params ...any) []*util.Obj {
	db, err := sql.Open("sqlite", sqliteURI(file))
	if err != nil {
		return []*util.Obj{}
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	rows, err := db.Query(q, params...)
	if err != nil {
		return []*util.Obj{}
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []*util.Obj{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if rows.Scan(ptrs...) != nil {
			return []*util.Obj{}
		}
		o := util.NewObj()
		for i, c := range cols {
			o.Set(c, sqlValue(vals[i]))
		}
		out = append(out, o)
	}
	if rows.Err() != nil {
		return []*util.Obj{}
	}
	return out
}

// sqlValue：node:sqlite 的列值映射（INTEGER/REAL → number，TEXT → string，NULL → null，BLOB → Uint8Array）。
func sqlValue(v any) any {
	switch x := v.(type) {
	case int64:
		return float64(x)
	case float64:
		return x
	case []byte:
		return append([]byte(nil), x...)
	case string:
		return x
	case nil:
		return nil
	case bool:
		if x {
			return float64(1)
		}
		return float64(0)
	}
	return v
}

func mtimeMs(fi os.FileInfo) float64 {
	t := fi.ModTime()
	return float64(float64(t.Unix())*1e3) + float64(t.Nanosecond())/1e6
}

// DBSignature = dbSignature（"" , false = null）。
func DBSignature(file string) (string, bool) {
	a, err := os.Stat(file)
	if err != nil {
		return "", false
	}
	w := ""
	if b, err := os.Stat(file + "-wal"); err == nil {
		w = strconv.FormatInt(b.Size(), 10) + ":" + util.FormatNumber(mtimeMs(b))
	}
	return strconv.FormatInt(a.Size(), 10) + ":" + util.FormatNumber(mtimeMs(a)) + ":" + w, true
}

func ReadOpencodeRows(file string, sinceUpdated float64) []*util.Obj {
	return selectRows(file, `SELECT id, session_id, time_updated AS updated,
            COALESCE(json_extract(data,'$.time.created'), time_created) AS created,
            json_extract(data,'$.modelID') AS model,
            json_extract(data,'$.providerID') AS provider,
            json_extract(data,'$.tokens.input') AS input,
            json_extract(data,'$.tokens.output') AS output,
            json_extract(data,'$.tokens.reasoning') AS reasoning,
            json_extract(data,'$.tokens.cache.read') AS cache_read,
            json_extract(data,'$.tokens.cache.write') AS cache_write,
            json_extract(data,'$.path.cwd') AS cwd
     FROM message
     WHERE json_valid(data) AND json_extract(data,'$.role') = 'assistant' AND time_updated >= ?
     ORDER BY time_updated ASC
     LIMIT `+strconv.Itoa(DBBatch), sinceUpdated)
}

func ReadCopilotRows(file string, lastID float64) []*util.Obj {
	return selectRows(file, `SELECT id, session_id, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, created_at
     FROM assistant_usage_events
     WHERE id > ?
     ORDER BY id ASC
     LIMIT `+strconv.Itoa(DBBatch), lastID)
}

// SelectRows：只读执行一条 SELECT（node:sqlite .all() 语义）；打不开 / 出错返回空切片。供 core/cli 的 codexThreadIndex 复用。
func SelectRows(file, q string, params ...any) []*util.Obj { return selectRows(file, q, params...) }
