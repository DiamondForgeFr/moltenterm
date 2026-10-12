// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"strings"
	"testing"
)

func denyCheck(tool string, input map[string]any) PermissionCheck {
	return PermissionCheck{
		Tool:     tool,
		Input:    input,
		Cwd:      "/Users/me/work/app",
		Home:     "/Users/me",
		TempDirs: []string{"/tmp", "/private/tmp", "/var/folders"},
		Branch: func(dir string) string {
			if strings.HasPrefix(dir, "/Users/me/work/app") {
				return "develop"
			}
			return "feature/1-x"
		},
	}
}

func bash(command string) PermissionCheck {
	return denyCheck("Bash", map[string]any{"command": command})
}

// TC-SHELL-132 and the edges of DS-SHELL-111.
func TestDenyListBash(t *testing.T) {
	cases := []struct {
		command string
		want    string
	}{
		{"rm -rf ./build", ""},
		{"rm -rf build dist/x", ""},
		{"rm -rf /tmp/scratch", ""},
		{"rm -rf /private/tmp/mtauto/d", ""},
		{"rm -rf /var/folders/ab/T/x", ""},
		{"rm -f /Users/me/work/app/out.log", ""},
		{"rm notes.txt /Users/me/other.txt", ""},
		{"rm -rf ~/projects", reasonRemove},
		{"rm -rf /Users/x/other", reasonRemove},
		{"rm -rf ../sibling", reasonRemove},
		{"rm -rf .", reasonRemove},
		{"rm -rf /Users/me/work/app", reasonRemove},
		{"rm -rf /", reasonRemove},
		{"rm -rf /tmp", reasonRemove},
		{`rm -rf "$TARGET"`, reasonRemove},
		{"rm -rf $(pwd)/x", reasonRemove},
		{"rm --recursive --force /etc/x", reasonRemove},
		{"rm -r -- -weird", ""},
		{"sudo rm -rf /opt/x", reasonRemove},
		{"FOO=1 env -i /bin/rm -Rf /opt/x", reasonRemove},
		{"npm test && rm -rf ~/x", reasonRemove},
		{"ls | xargs echo; rm -rf /opt/x", reasonRemove},
		{"cd /tmp/x && rm -rf y", ""},
		{"cd /opt && rm -rf y", reasonRemove},
		{"cd $DIR && rm -rf y", reasonRemove},
		{"echo 'rm -rf /' > /tmp/note", ""},
		{"git push --force origin main", reasonForcePush},
		{"git push -f", reasonForcePush},
		{"git push --force-with-lease origin feature/1-x", ""},
		{"git push --force-with-lease", reasonForcePush},
		{"git -C /opt/other push --force-with-lease", ""},
		{"git push origin +main", reasonForcePush},
		{"git push origin :master", reasonForcePush},
		{"git push origin --delete trunk", reasonForcePush},
		{"git push origin HEAD:refs/heads/main --force", reasonForcePush},
		{"git push --mirror", reasonForcePush},
		{"git push -u origin feature/386-x", ""},
		{"git push origin main", ""},
		{"git commit -m 'fix .env loading'", ""},
		{"cat .env", reasonCredential},
		{"cat .env.example", ""},
		{"source ./config/.env.local", reasonCredential},
		{"echo x > .env", reasonCredential},
		{"cat ~/.ssh/id_ed25519.pub", reasonCredential},
		{"scp -i ~/.ssh/deploy host:x .", reasonCredential},
		{"cat ~/.aws/credentials", reasonCredential},
		{"cp server.pem /tmp/x", reasonCredential},
		{"jq .key file.json", ""},
		{"security find-generic-password -s x", reasonKeychain},
		{"go test ./... 2>/dev/null", ""},
		{"cat <<'EOF' > /tmp/x\nit's here\nEOF", ""},
		{"echo 'unclosed && rm -rf ~/x", reasonRemove},
	}
	for _, tc := range cases {
		got := DenyReason(bash(tc.command))
		if tc.want == "" && got != "" {
			t.Errorf("%q: denied (%s), want approved", tc.command, got)
		}
		if tc.want != "" && !strings.HasPrefix(got, tc.want) {
			t.Errorf("%q: %q, want %q…", tc.command, got, tc.want)
		}
	}
}

func TestDenyListTools(t *testing.T) {
	cases := []struct {
		tool  string
		input map[string]any
		want  string
	}{
		{"Read", map[string]any{"file_path": "/Users/me/.ssh/id_ed25519"}, reasonCredential},
		{"Read", map[string]any{"file_path": "/Users/me/work/app/.env.example"}, ""},
		{"Edit", map[string]any{"file_path": "/Users/me/work/app/.env"}, reasonCredential},
		{"Write", map[string]any{"file_path": "/Users/me/Library/Keychains/login.keychain-db"}, reasonCredential},
		{"Grep", map[string]any{"pattern": "x", "path": "~/.gnupg"}, reasonCredential},
		{"Read", map[string]any{"file_path": "/Users/me/work/app/main.go"}, ""},
		{"AskUserQuestion", map[string]any{}, reasonQuestion},
		{"ExitPlanMode", map[string]any{}, reasonQuestion},
		{"WebFetch", map[string]any{"url": "https://example.com/.env"}, ""},
		{"mcp__molten__open", map[string]any{"path": "/x"}, ""},
	}
	for _, tc := range cases {
		got := DenyReason(denyCheck(tc.tool, tc.input))
		if tc.want == "" && got != "" {
			t.Errorf("%s %v: denied (%s)", tc.tool, tc.input, got)
		}
		if tc.want != "" && !strings.HasPrefix(got, tc.want) {
			t.Errorf("%s %v: %q, want %q…", tc.tool, tc.input, got, tc.want)
		}
	}
}

// A session in the home folder has no folder of its own: any recursive deletion asks, the temporary folders aside.
func TestDenyListHomeSession(t *testing.T) {
	c := bash("rm -rf Downloads/old")
	c.Cwd = "/Users/me"
	if DenyReason(c) == "" {
		t.Fatal("a deletion in the home folder must ask")
	}
	c = bash("rm -rf /tmp/x")
	c.Cwd = "/Users/me"
	if got := DenyReason(c); got != "" {
		t.Fatalf("temporary folder: %s", got)
	}
	c = bash("git push --force")
	c.Branch = nil
	if DenyReason(c) == "" {
		t.Fatal("an unknown branch counts as a main one")
	}
}
