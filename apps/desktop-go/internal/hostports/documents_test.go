package hostports

import (
	"errors"
	"testing"
)

func TestLinuxDocuments(t *testing.T) {
	files := map[string]string{}
	rf := func(p string) ([]byte, error) {
		if s, ok := files[p]; ok {
			return []byte(s), nil
		}
		return nil, errors.New("enoent")
	}
	cases := []struct {
		name, xdg, file, cfgPath, want string
	}{
		{"no file", "", "", "", "/h/Documents"},
		{"home rel", "", `XDG_DOCUMENTS_DIR="$HOME/Docs"`, "/h/.config", "/h/Docs"},
		{"abs + last wins", "", "XDG_DOCUMENTS_DIR=\"/a\"\n  XDG_DOCUMENTS_DIR = \"/b/\"", "/h/.config", "/b"},
		{"relative ignored", "", `XDG_DOCUMENTS_DIR="Docs"`, "/h/.config", "/h/Documents"},
		{"escape", "", `XDG_DOCUMENTS_DIR="$HOME/My\"D"`, "/h/.config", `/h/My"D`},
		{"xdg config home", "/c", `XDG_DOCUMENTS_DIR="/x"`, "/c", "/x"},
		{"other type", "", `XDG_DOWNLOAD_DIR="/x"`, "/h/.config", "/h/Documents"},
		{"home itself", "", `XDG_DOCUMENTS_DIR="$HOME/"`, "/h/.config", "/h"},
	}
	for _, c := range cases {
		files = map[string]string{}
		if c.file != "" {
			files[c.cfgPath+"/user-dirs.dirs"] = c.file
		}
		env := map[string]string{"HOME": "/h", "XDG_CONFIG_HOME": c.xdg}
		got := linuxDocuments(func(k string) string { return env[k] }, rf, func() string { return "/h" })
		if got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
