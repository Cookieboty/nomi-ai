package shared

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestCleanTitleCommands(t *testing.T) {
	bare := "<command-name>/clear</command-name>\n  <command-message>clear</command-message>\n  <command-args></command-args>"
	if got := CleanTitle(bare, 80); got != nil {
		t.Fatalf("bare /clear should not be a title, got %q", *got)
	}
	withArgs := "<command-name>/review</command-name><command-args>pr 3</command-args>"
	if got := CleanTitle(withArgs, 80); got == nil || *got != "/review pr 3" {
		t.Fatalf("command with args = %v", got)
	}
}

func TestTitleFromMessagesSkipsBareCommands(t *testing.T) {
	msgs := []Json{
		AsObj(util.NewObj("role", "user", "content", "<command-name>/clear</command-name><command-args> </command-args>")),
		AsObj(util.NewObj("role", "assistant", "content", "ok")),
		AsObj(util.NewObj("role", "user", "content", "准备发布流程")),
	}
	if got := TitleFromMessages(msgs); got == nil || *got != "准备发布流程" {
		t.Fatalf("title = %v", got)
	}
}
