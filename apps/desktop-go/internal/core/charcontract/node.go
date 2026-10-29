package charcontract

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// 与 node.ts（readPackDirSync / validatePackDirSync）对应。

func shouldPreload(rel string) bool {
	return strings.HasSuffix(rel, ".json") || rel == FileLegacySysPrompt
}

func walkSync(root string) ([]string, error) {
	var out []string
	var visit func(dir, base string) error
	visit = func(dir, base string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if e.Name() == ".DS_Store" {
				continue
			}
			rel := e.Name()
			if base != "" {
				rel = base + "/" + e.Name()
			}
			// withFileTypes：Dirent 类型不跟随符号链接
			if e.Type().IsDir() {
				if err := visit(filepath.Join(dir, e.Name()), rel); err != nil {
					return err
				}
			} else if e.Type().IsRegular() {
				out = append(out, rel)
			}
		}
		return nil
	}
	if err := visit(root, ""); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool { return lessUTF16(out[i], out[j]) })
	return out, nil
}

// DecodeUTF8 = TextDecoder('utf-8')（不剥 BOM，Node readFileSync 'utf8' 的行为）：
// 非法序列按 WHATWG「最大子部分」各替换为一个 U+FFFD。
func DecodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for i := 0; i < len(b); {
		c := b[i]
		if c < 0x80 {
			sb.WriteByte(c)
			i++
			continue
		}
		var need int
		lo, hi := byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c >= 0xE0 && c <= 0xEF:
			need = 2
			if c == 0xE0 {
				lo = 0xA0
			} else if c == 0xED {
				hi = 0x9F
			}
		case c >= 0xF0 && c <= 0xF4:
			need = 3
			if c == 0xF0 {
				lo = 0x90
			} else if c == 0xF4 {
				hi = 0x8F
			}
		default:
			sb.WriteRune(utf8.RuneError)
			i++
			continue
		}
		j := i + 1
		ok := true
		for k := 0; k < need; k++ {
			if j >= len(b) || b[j] < lo || b[j] > hi {
				ok = false
				break
			}
			lo, hi = 0x80, 0xBF
			j++
		}
		if !ok {
			sb.WriteRune(utf8.RuneError)
			i = j
			continue
		}
		sb.Write(b[i:j])
		i = j
	}
	return sb.String()
}

type dirSource struct {
	files []string
	texts map[string]string
	sizes map[string]int64
}

func (d *dirSource) key(p string) (string, bool) {
	return NormalizePackPath(strings.ReplaceAll(p, string(filepath.Separator), "/"))
}

// ReadPackDirSync = readPackDirSync。
func ReadPackDirSync(dir string) (PackSource, error) {
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return PackSource{}, fmt.Errorf("character pack directory not found: %s", dir)
	}
	files, err := walkSync(dir)
	if err != nil {
		return PackSource{}, err
	}
	d := &dirSource{files: files, texts: map[string]string{}, sizes: map[string]int64{}}
	for _, rel := range files {
		abs := filepath.Join(dir, filepath.FromSlash(rel))
		fi, err := os.Stat(abs)
		if err != nil {
			return PackSource{}, err
		}
		d.sizes[rel] = fi.Size()
		if shouldPreload(rel) {
			b, err := os.ReadFile(abs)
			if err != nil {
				return PackSource{}, err
			}
			d.texts[rel] = DecodeUTF8(b)
		}
	}
	return PackSource{
		Files: files,
		ReadJSON: func(p string) (any, error) {
			k, ok := d.key(p)
			if !ok {
				return Undef, nil
			}
			text, ok := d.texts[k]
			if !ok {
				return Undef, nil
			}
			v, err := ParseJSON(text)
			if err != nil {
				return nil, fmt.Errorf("%s: %s", k, err.Error())
			}
			return v, nil
		},
		ReadText: func(p string) (string, bool) {
			k, ok := d.key(p)
			if !ok {
				return "", false
			}
			t, ok := d.texts[k]
			return t, ok
		},
		SizeOf: func(p string) (int64, bool) {
			k, ok := d.key(p)
			if !ok {
				return 0, false
			}
			s, ok := d.sizes[k]
			return s, ok
		},
	}, nil
}

// ValidatePackDirSync = validatePackDirSync。
func ValidatePackDirSync(dir string, opts ValidateOptions) ValidateResult {
	src, err := ReadPackDirSync(dir)
	if err != nil {
		return ValidateResult{Errors: []PackIssue{{"error", "manifest-missing", FileManifest, []any{}, err.Error()}}}
	}
	return ValidatePack(src, opts)
}

// LoadPackResult = packResolve.ts LoadPackResult。
type LoadPackResult struct {
	OK         bool
	Pack       *Obj
	Downgraded []string
	Reason     string
}

// LoadPackAt = packResolve.ts loadPackAt。
// Node 里 validatePack 抛错会冒到 resolveCharacterPack 外；Go 端把它当作该候选无效（理由为错误信息），
// 以免一个坏的覆盖包让启动失败（临时偏差，见 docs）。
func LoadPackAt(root string, lenient bool) (r LoadPackResult) {
	defer func() {
		if e := recover(); e != nil {
			t, ok := e.(JSThrow)
			if !ok {
				panic(e)
			}
			r = LoadPackResult{Reason: t.Message}
		}
	}()
	res := ValidatePackDirSync(root, ValidateOptions{Lenient: lenient})
	if res.OK && res.Pack != nil {
		dg := []string{}
		for _, w := range res.Warnings {
			if IsLenientDowngrade(w) {
				dg = append(dg, w.File+": "+w.Message)
			}
		}
		return LoadPackResult{OK: true, Pack: res.Pack, Downgraded: dg}
	}
	if len(res.Errors) > 0 {
		return LoadPackResult{Reason: res.Errors[0].File + ": " + res.Errors[0].Message}
	}
	return LoadPackResult{Reason: "invalid character pack"}
}
