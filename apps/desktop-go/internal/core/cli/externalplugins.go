package cli

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type StoredExternal struct {
	ID     string
	Spec   *util.Obj // nil = null
	Errors []string
}

// ExternalPluginStore = ExternalPluginStore（userData/cli-plugins/external/<id>.json）。
type ExternalPluginStore struct {
	dir      string
	reserved []string
}

func NewExternalPluginStore(dir string, reserved []string) *ExternalPluginStore {
	return &ExternalPluginStore{dir: dir, reserved: reserved}
}

func (s *ExternalPluginStore) file(id string) string { return filepath.Join(s.dir, id+".json") }

func (s *ExternalPluginStore) Load() []StoredExternal {
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return []StoredExternal{}
	}
	names := []string{}
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Slice(names, func(i, j int) bool { return utf16Less(names[i], names[j]) })
	out := []StoredExternal{}
	for _, n := range names {
		id := n[:len(n)-len(".json")]
		raw, err := readJSONFile(filepath.Join(s.dir, n))
		if err != nil {
			out = append(out, StoredExternal{ID: id, Errors: []string{"unreadable: " + err.Error()}})
			continue
		}
		errs := clisdk.ValidateExternalSpec(raw, s.reserved)
		if len(errs) == 0 {
			if rid := raw.(*util.Obj).Get("id"); rid != id {
				errs = append(errs, "file name "+n+" does not match id "+util.JSString(rid))
			}
		}
		if len(errs) > 0 {
			out = append(out, StoredExternal{ID: id, Errors: errs})
		} else {
			out = append(out, StoredExternal{ID: id, Spec: clisdk.NormalizeExternalSpec(raw.(*util.Obj)), Errors: []string{}})
		}
	}
	return out
}

// Save 校验并保存；返回 (spec, nil) 或 (nil, errors)。
func (s *ExternalPluginStore) Save(raw any) (*util.Obj, []string) {
	if errs := clisdk.ValidateExternalSpec(raw, s.reserved); len(errs) > 0 {
		return nil, errs
	}
	spec := clisdk.NormalizeExternalSpec(raw.(*util.Obj))
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		panic(err) // Node 同步抛出
	}
	if err := utils.WritePrivateFileAtomic(s.file(util.Str(spec.Get("id"))), []byte(util.StringifyIndent(spec, "  "))); err != nil {
		panic(err)
	}
	return spec, nil
}

var extRemoveID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

func (s *ExternalPluginStore) Remove(id string) bool {
	if !extRemoveID.MatchString(id) {
		return false
	}
	// fs.rmSync 对目录（无 recursive）也会失败
	fi, err := os.Lstat(s.file(id))
	if err != nil || fi.IsDir() {
		return false
	}
	return os.Remove(s.file(id)) == nil
}

// readJSONFile：fs.readFileSync + JSON.parse，错误文案与 Node 一致（V8 SyntaxError.message / fs 错误）。
func readJSONFile(p string) (any, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, syscall.EISDIR) {
			return nil, errors.New("EISDIR: illegal operation on a directory, read")
		}
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("ENOENT: no such file or directory, open '" + p + "'")
		}
		if errors.Is(err, os.ErrPermission) {
			return nil, errors.New("EACCES: permission denied, open '" + p + "'")
		}
		return nil, err
	}
	src := string(b) // readFileSync(utf8) 不去 BOM；BOM 由 V8 解析器判定报错
	if _, err := charcontract.ParseJSON(src); err != nil {
		return nil, err
	}
	return util.ParseString(src)
}
