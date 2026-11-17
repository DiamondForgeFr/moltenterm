// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// testOwnFolder stands for his own folder in the tests: a real folder, inside a "data" folder, beside a fake home with
// the places an agent must never reach without asking. Made once for the package, removed after it.
var testOwnFolder string

// testRoot holds data/brokk (his folder), data/db, and home/.ssh, home/.claude, home/.zshrc.
var testRoot string

func TestMain(m *testing.M) {
	root, err := os.MkdirTemp("", "brokkguard")
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	root, _ = filepath.EvalSymlinks(root)
	testRoot = root
	testOwnFolder = filepath.Join(root, "data", "brokk")
	for _, dir := range []string{testOwnFolder, filepath.Join(testOwnFolder, "notes"), filepath.Join(testOwnFolder, ".claude"),
		filepath.Join(root, "data", "db"), filepath.Join(root, "home", ".ssh"), filepath.Join(root, "home", ".claude"),
		filepath.Join(root, "home", ".codex"), filepath.Join(root, "home", "Library", "LaunchAgents")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
	}
	for _, file := range []string{filepath.Join(testOwnFolder, "notes", "idea.md"), filepath.Join(testOwnFolder, "CLAUDE.md"),
		filepath.Join(root, "home", ".ssh", "id_rsa"), filepath.Join(root, "home", ".zshrc"), filepath.Join(root, "data", "db", "waveterm.db")} {
		if err := os.WriteFile(file, []byte("synthetic"), 0o600); err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
	}
	// A symlink in his folder that leads out of it.
	_ = os.Symlink(filepath.Join(root, "home", ".ssh"), filepath.Join(testOwnFolder, "keys"))
	code := m.Run()
	os.RemoveAll(root)
	os.Exit(code)
}

// #2257, second review: boss:autoapprove lets through only what is plainly harmless, by an allowlist; each bypass of
// the earlier text denylist asks.
func TestAutoApproveAllowsOnlyThePlainlyHarmless(t *testing.T) {
	t.Parallel()
	home := filepath.Join(testRoot, "home")
	own := testOwnFolder
	env := PermitGuardEnv{OwnFolder: own}
	for _, tc := range []struct {
		name string
		kind string
		subj string
		cwd  string
		want string
	}{
		// The bypasses of the review.
		{"sh -c", PermitKindCommand, `sh -c "git push -f"`, own, GuardCommand},
		{"absolute security", PermitKindCommand, "/usr/bin/security find-generic-password -s x", own, GuardCommand},
		{"security -q", PermitKindCommand, "security -q find-generic-password", own, GuardCommand},
		{"git -c push", PermitKindCommand, "git -c x=y push --force", own, GuardCommand},
		{"git -C quoted push", PermitKindCommand, `git -C "a b" push -f`, own, GuardCommand},
		{"git push", PermitKindCommand, "git push origin main", own, GuardCommand},
		{"quoted $HOME", PermitKindCommand, `cat "$HOME"/.ssh/id_rsa`, own, GuardCommand},
		{"cd home", PermitKindCommand, "cd ~ && cat .ssh/id_rsa", own, GuardCommand},
		{"tilde dot", PermitKindRead, "~/./.ssh/id_rsa", own, GuardPath},
		{"glob", PermitKindCommand, "cat notes/*", own, GuardCommand},
		{"escaped space", PermitKindCommand, `cat my\ file`, own, GuardCommand},
		{"dotdot from his folder", PermitKindCommand, "cat ../db/waveterm.db", own, GuardCommand},
		{"dotdot read", PermitKindRead, filepath.Join(own, "..", "db", "waveterm.db"), own, GuardPath},
		{"data folder", PermitKindRead, filepath.Join(testRoot, "data", "db", "waveterm.db"), own, GuardPath},
		{"claude settings", PermitKindEdit, filepath.Join(home, ".claude", "settings.json"), own, GuardPath},
		{"codex folder", PermitKindWrite, filepath.Join(home, ".codex", "config.toml"), own, GuardPath},
		{"shell rc", PermitKindEdit, filepath.Join(home, ".zshrc"), own, GuardPath},
		{"launch agents", PermitKindWrite, filepath.Join(home, "Library", "LaunchAgents", "x.plist"), own, GuardPath},
		{"ssh by path", PermitKindRead, filepath.Join(home, ".ssh", "id_rsa"), own, GuardPath},
		{"symlink out of his folder", PermitKindRead, filepath.Join(own, "keys", "id_rsa"), own, GuardPath},
		{"symlink by command", PermitKindCommand, "cat keys/id_rsa", own, GuardCommand},
		{"his own agent settings", PermitKindWrite, filepath.Join(own, ".claude", "settings.json"), own, GuardPath},
		{"his brief", PermitKindEdit, filepath.Join(own, "CLAUDE.md"), own, GuardPath},
		{"his brief by command", PermitKindCommand, "cat CLAUDE.md", own, GuardCommand},
		{"a pattern with dots", PermitKindCommand, "go test ./...", own, GuardCommand},
		{"redirect", PermitKindCommand, "echo hi > notes/x", own, GuardCommand},
		{"command substitution", PermitKindCommand, "echo $(id)", own, GuardCommand},
		{"backticks", PermitKindCommand, "echo `id`", own, GuardCommand},
		{"chained", PermitKindCommand, "ls; rm -rf notes", own, GuardCommand},
		{"absolute argument", PermitKindCommand, "cat " + filepath.Join(home, ".zshrc"), own, GuardCommand},
		{"another first word", PermitKindCommand, "rm notes/idea.md", own, GuardCommand},
		{"curl", PermitKindCommand, "curl https://example.com", own, GuardCommand},
		{"a command outside his folder", PermitKindCommand, "ls", home, GuardCwd},
		{"newline", PermitKindCommand, "ls\nrm x", own, GuardCommand},
		{"web fetch", PermitKindFetch, "https://example.com", own, GuardWeb},
		{"web search", PermitKindSearch, "anything", own, GuardWeb},
		{"patch outside", PermitKindPatch, "update ../db/waveterm.db", own, GuardPath},
		// What may go.
		{"ls", PermitKindCommand, "ls -la", own, ""},
		{"grep in his notes", PermitKindCommand, "grep -rn idea notes", own, ""},
		{"git status", PermitKindCommand, "git status", own, ""},
		{"git log", PermitKindCommand, "git log --oneline -5", own, ""},
		{"tests", PermitKindCommand, "npm test", own, ""},
		{"a note", PermitKindWrite, filepath.Join(own, "notes", "new.md"), own, ""},
		{"a note, relative patch", PermitKindPatch, "update notes/idea.md\nadd notes/next.md", own, ""},
		{"reading his note", PermitKindRead, filepath.Join(own, "notes", "idea.md"), own, ""},
	} {
		got := GuardReason(PermissionAsk{Kind: tc.kind, Subject: tc.subj, Cwd: tc.cwd}, env)
		if got != tc.want {
			t.Errorf("%s: %q gives %q, want %q", tc.name, tc.subj, got, tc.want)
		}
	}
	if got := GuardReason(PermissionAsk{Kind: PermitKindCommand, Subject: "ls", Cwd: own}, PermitGuardEnv{}); got == "" {
		t.Fatal("without his folder nothing goes")
	}
}
