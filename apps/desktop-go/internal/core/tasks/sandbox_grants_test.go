package tasks

import (
	"slices"
	"testing"
)

// 沙箱预授权：授权里勾的类别（去重），有 GitHub 对外能力时加上 SSH 与 Git 凭据
func TestSandboxGrants(t *testing.T) {
	plain := Task{Grant: Grant{Sandbox: []string{"cloud", "cloud", ""}}}
	if got := SandboxGrants(plain); !slices.Equal(got, []string{"cloud"}) {
		t.Fatalf("plain = %v", got)
	}
	gh := Task{Grant: Grant{Connections: []ConnectionGrant{{ConnectionID: "c", Capabilities: []string{"github.read", "github.pr.create"}}}}}
	if got := SandboxGrants(gh); !slices.Equal(got, []string{"ssh"}) {
		t.Fatalf("github = %v", got)
	}
	readOnly := Task{Grant: Grant{Connections: []ConnectionGrant{{ConnectionID: "c", Capabilities: []string{"github.read"}}}}}
	if got := SandboxGrants(readOnly); len(got) != 0 {
		t.Fatalf("read-only GitHub needs no SSH, got %v", got)
	}
}
