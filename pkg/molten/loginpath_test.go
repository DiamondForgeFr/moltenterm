// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"path/filepath"
	"testing"
)

// #1667: a CLI installed after launch in a folder the shell's rc file adds is found once the PATH is read again.
func TestRefreshLoginPathSeesAFolderAddedAfterLaunch(t *testing.T) {
	root := t.TempDir()
	before := filepath.Join(root, "usr-bin")
	added := filepath.Join(root, ".kimi-code", "bin")
	current := before
	ok := true
	previous := loginPathReader
	loginPathReader = func() (string, bool) { return current, ok }
	t.Cleanup(func() { loginPathReader = previous })

	RefreshLoginPath()
	if got := LoginPath(); got != before {
		t.Fatalf("LoginPath = %q, want %q", got, before)
	}
	current = before + string(filepath.ListSeparator) + added
	if got := LoginPath(); got != before {
		t.Fatalf("LoginPath re-read the shell without a refresh: %q", got)
	}
	if got := RefreshLoginPath(); got != current {
		t.Fatalf("RefreshLoginPath = %q, want %q", got, current)
	}
	if got := LoginPath(); got != current {
		t.Fatalf("LoginPath after refresh = %q, want %q", got, current)
	}
	ok = false
	current = ""
	if got := RefreshLoginPath(); got != before+string(filepath.ListSeparator)+added {
		t.Fatalf("a failed read replaced the PATH: %q", got)
	}
}
