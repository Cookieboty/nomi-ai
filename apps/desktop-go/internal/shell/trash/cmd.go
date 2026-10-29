package trash

import (
	"fmt"
	"os/exec"
	"strings"
)

func runCmd(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		if s := strings.TrimSpace(string(out)); s != "" {
			return fmt.Errorf("%s: %s", name, s)
		}
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}
