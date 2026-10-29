package charcontract

import (
	_ "embed"
	"encoding/json"
)

// contract.json / voice-ids.json 是 packages/character-contract 同名文件的副本（contract_sync_test 校验一致）。

//go:embed contract.json
var contractJSON []byte

//go:embed voice-ids.json
var voiceIDsJSON []byte

const ContractVersion = 1

var (
	OnboardingFiles    = []string{"welcome.webp", "profile.webp", "provider.webp", "privacy.webp"}
	CharacterLocales   = []string{"zh", "en"}
	PrimaryLocale      = "zh"
	SemanticEmotions   = []string{"neutral", "happy", "sad", "angry", "surprised", "relaxed", "shy", "confused", "sleepy"}
	SemanticActivities = []string{"idle", "thinking", "toolRunning"}
	SemanticGestures   = []string{"wave", "greet", "nod", "shakeHead", "bow", "salute", "pray", "okHand", "think", "explain",
		"eureka", "puzzled", "listen", "lookAround", "lookLeftRight", "peek", "heart", "blowKiss", "shy", "coverFace",
		"apologize", "surprise", "startle", "sigh", "smug", "aggrieved", "tears", "angry", "coldSweat", "daze", "cheer",
		"thumbsUp", "peace", "celebrate", "clap", "hop", "wink", "tongue", "cute", "reachOut", "work", "yawn", "stretch",
		"goodnight", "hum", "random"}
	MappingReservedTargets = []string{"random"}
)

const (
	FileManifest        = "manifest.json"
	FilePersona         = "persona.json"
	FileMapping         = "mapping.json"
	DirLocales          = "locales"
	DirLegacyCopy       = "copy"
	FileLegacySysPrompt = "persona/system-prompt.md"
)

// Contract 是 contract.json 中本包用到的部分。
var Contract struct {
	Sprite struct {
		ActionIDs []string `json:"actionIds"`
	} `json:"sprite"`
	Voice struct {
		Locales         []string `json:"locales"`
		RequiredClipIDs []string `json:"requiredClipIds"`
	} `json:"voice"`
}

var voiceByLegacyKey map[string]string

func init() {
	if err := json.Unmarshal(contractJSON, &Contract); err != nil {
		panic(err)
	}
	var v struct {
		ByLegacyKey map[string]string `json:"byLegacyKey"`
	}
	if err := json.Unmarshal(voiceIDsJSON, &v); err != nil {
		panic(err)
	}
	voiceByLegacyKey = v.ByLegacyKey
}

// ResolveVoiceClipID = migrations.ts resolveVoiceClipId。
func ResolveVoiceClipID(keyOrID string) string {
	if id, ok := voiceByLegacyKey[keyOrID]; ok {
		return id
	}
	return keyOrID
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
