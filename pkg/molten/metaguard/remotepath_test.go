// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package metaguard

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

func TestIsLoopbackHostNumericForms(t *testing.T) {
	for _, host := range []string{"127.1", "2130706433", "0x7f.1", "0177.0.0.1", "0x7f000001", "127.0.1", "0", "0.0.0.0", "::", "::ffff:127.0.0.1", ""} {
		if !IsLoopbackHost(host) {
			t.Errorf("%q is this computer", host)
		}
	}
	for _, host := range []string{"10.1", "203.0.113.7", "167772161", "build.example", "127.example", "0x7f.example"} {
		if IsLoopbackHost(host) {
			t.Errorf("%q is not this computer", host)
		}
	}
}

func TestSensitiveLocalPaths(t *testing.T) {
	home := wavebase.GetHomeDir()
	for _, rel := range []string{".ssh", ".ssh/id_ed25519", ".zshrc", ".bashrc", ".config/fish/config.fish", ".aws/credentials", ".config/gcloud/x", "Library/LaunchAgents/x.plist", ".config/autostart/x.desktop", "Library/Keychains/login.keychain-db", ".kube/config", ".git-credentials"} {
		if !IsSensitiveLocalPath(CleanLocalPath(filepath.Join(home, rel))) {
			t.Errorf("~/%s is a sensitive location", rel)
		}
	}
	for _, abs := range []string{"/etc/profile", "/Library/LaunchDaemons/x.plist"} {
		if !IsSensitiveLocalPath(CleanLocalPath(abs)) {
			t.Errorf("%s is a sensitive location", abs)
		}
	}
	for _, rel := range []string{"Downloads/x.txt", "work/project/main.go", ".sshfoo/x", ".zshrc-notes/x"} {
		if IsSensitiveLocalPath(CleanLocalPath(filepath.Join(home, rel))) {
			t.Errorf("~/%s is not a sensitive location", rel)
		}
	}
}

func TestCleanLocalPathAndWithin(t *testing.T) {
	home := wavebase.GetHomeDir()
	if got := CleanLocalPath("~/Downloads/../Downloads/x.txt"); got != CleanLocalPath(filepath.Join(home, "Downloads", "x.txt")) {
		t.Errorf("CleanLocalPath = %q", got)
	}
	if got := CleanLocalPath("notes.txt"); !filepath.IsAbs(got) {
		t.Errorf("a relative path stays relative: %q", got)
	}
	dir := t.TempDir()
	link := filepath.Join(dir, "link")
	ssh := filepath.Join(home, ".ssh")
	if err := os.Symlink(ssh, link); err == nil {
		if !IsSensitiveLocalPath(CleanLocalPath(filepath.Join(link, "id_ed25519"))) {
			t.Error("a link to ~/.ssh got through")
		}
	}
	if !PathWithin("/a/b/c", "/a/b") || !PathWithin("/a/b", "/a/b") || PathWithin("/a/bc", "/a/b") || PathWithin("/a", "/a/b") || PathWithin("/a/b/../c", "/a/b") {
		t.Error("PathWithin")
	}
	if got := ShownPath("/tmp/a\nb‮c"); got != "/tmp/a?b?c" {
		t.Errorf("ShownPath = %q", got)
	}
}

func TestAlwaysFolder(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "x.log")
	if folder, ok := AlwaysFolder(CleanLocalPath(file)); !ok || folder != CleanLocalPath(dir) {
		t.Errorf("AlwaysFolder(%s) = %q %v", file, folder, ok)
	}
	if folder, ok := AlwaysFolder(CleanLocalPath(dir)); !ok || folder != CleanLocalPath(dir) {
		t.Errorf("a folder covers itself: %q %v", folder, ok)
	}
	home := wavebase.GetHomeDir()
	for _, path := range []string{filepath.Join(home, "x.txt"), "/x.txt", filepath.Join(home, ".ssh", "known_hosts"), filepath.Join(home, ".config", "autostart", "a")} {
		if folder, ok := AlwaysFolder(CleanLocalPath(path)); ok {
			t.Errorf("%s offers always for %s", path, folder)
		}
	}
}
