package charcontract

import (
	"bytes"
	"os"
	"testing"
)

func TestContractFilesInSync(t *testing.T) {
	for name, got := range map[string][]byte{"contract.json": contractJSON, "voice-ids.json": voiceIDsJSON} {
		want, err := os.ReadFile("../../../../../packages/character-contract/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s 与 packages/character-contract 不一致：重新复制", name)
		}
	}
}
