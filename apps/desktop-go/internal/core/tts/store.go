package tts

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Store = TtsConfigStore（userData/tts-config.json）
type Store struct {
	UserData string
	Now      func() time.Time
}

func (s *Store) path() string { return filepath.Join(s.UserData, "tts-config.json") }

// Load = load()：没有文件 / 读失败 → 默认
func (s *Store) Load() Config {
	b, err := os.ReadFile(s.path())
	if err != nil {
		return Default()
	}
	v, err := util.Parse(b)
	if err != nil {
		return Default()
	}
	return Normalize(v)
}

// Save = save(input)：校验不过抛 `TTS config invalid: …`
func (s *Store) Save(input any) (Config, error) {
	if ok, errs := Validate(input); !ok {
		return Config{}, errors.New("TTS config invalid: " + strings.Join(errs, ", "))
	}
	c := Normalize(input)
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	c.LastModified = float64(now().UnixMilli())
	if err := utils.WritePrivateFileAtomic(s.path(), []byte(util.StringifyIndent(c.Obj(), "  "))); err != nil {
		return Config{}, err
	}
	return c, nil
}

// Reset = reset()
func (s *Store) Reset() error {
	err := os.Remove(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
