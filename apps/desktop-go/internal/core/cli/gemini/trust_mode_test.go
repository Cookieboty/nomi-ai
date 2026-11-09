package gemini

import "testing"

func TestIsUntrustedModeError(t *testing.T) {
	if !IsUntrustedModeError("Internal error: Cannot enable privileged approval modes in an untrusted folder.") {
		t.Fatal("the mode refusal should be recognised")
	}
	// 每次启动都会打印的提示不是错误
	if IsUntrustedModeError("Skipping project agents due to untrusted folder.") {
		t.Fatal("the startup notice is not a mode refusal")
	}
}
