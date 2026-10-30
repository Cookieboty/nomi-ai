package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/character"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/persona"
)

// newPersona = createCore.startPersona：当前包 → 内置包 → 中性兜底；换包 / 换语言时有变化才发 persona.changed
func newPersona(cs *character.Service, router *contract.Router) *persona.Service {
	act := func(p *character.Pack) *persona.ActivePack {
		if p == nil {
			return nil
		}
		return &persona.ActivePack{Root: p.Root, Manifest: p.ManifestObj}
	}
	svc, err := persona.New([]persona.Source{
		persona.PackSource("", func() *persona.ActivePack { return act(cs.Resolved()) }, nil),
		persona.PackSource("builtin-pack", func() *persona.ActivePack { return act(cs.Builtin()) }, nil),
		persona.NeutralSource(),
	}, i18n.Locale)
	if err != nil {
		log.Fatal(err)
	}
	cs.OnChange(func() { svc.Reload() })
	svc.OnChange(func(p persona.Persona) { router.Emit("persona.changed", p) })
	p := svc.Get()
	log.Printf("persona: %s (%s)", p.CharacterID, p.DisplayName)
	return svc
}

// chatBgPresetFile = getChatBackgroundPresetFile：打包后在 resources/assets，开发时在 apps/desktop-electron/assets
func chatBgPresetFile() string {
	rel := filepath.Join("assets", "backgrounds", "nomi-preset.jpg")
	if r := os.Getenv("NOMI_RESOURCES"); r != "" {
		return filepath.Join(r, rel)
	}
	var starts []string
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	for _, d := range starts {
		for i := 0; i < 6; i++ {
			for _, c := range []string{filepath.Join(d, rel), filepath.Join(d, "apps", "desktop-electron", rel)} {
				if _, err := os.Stat(c); err == nil {
					return c
				}
			}
			d = filepath.Dir(d)
		}
	}
	return filepath.Join(filepath.Dir(os.Args[0]), rel)
}

// newCharacterService：角色包解析抛出的 TypeError（Node createCore 内同步抛出）→ main.ts 的
// console.error('❌ 应用启动失败:', error) + process.exit(1)
func newCharacterService(userData, resources, builtin string) (cs *character.Service) {
	defer func() {
		if r := recover(); r != nil {
			if t, ok := r.(charcontract.JSThrow); ok {
				fmt.Fprintln(os.Stderr, "❌ 应用启动失败:", "TypeError: "+t.Message)
				os.Exit(1)
			}
			panic(r)
		}
	}()
	return character.NewService(userData, resources, builtin)
}
