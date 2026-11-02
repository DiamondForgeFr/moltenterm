// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestModWatcherAtomicReplacementAndShutdown(t *testing.T) {
	base := t.TempDir()
	mods := filepath.Join(base, "mods")
	mod := filepath.Join(mods, "example")
	if err := os.MkdirAll(mod, 0755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(mod, "main.js")
	if err := os.WriteFile(file, []byte("before"), 0644); err != nil {
		t.Fatal(err)
	}
	notified := make(chan string, 16)
	w, err := MakeModWatcher(mods, filepath.Join(base, "state", StateFileName), filepath.Join(base, "trust", TrustFileName), 10*time.Millisecond, func(ids []string) {
		for _, id := range ids {
			if id != "example" {
				continue
			}
			content, err := os.ReadFile(file)
			if err == nil {
				select {
				case notified <- string(content):
				default:
				}
			}
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { defer close(done); w.Run() }()
	t.Cleanup(func() {
		w.Close()
		select {
		case <-done:
		case <-time.After(time.Minute):
			t.Error("watcher did not stop")
		}
	})
	for _, contents := range []string{"replacement one", "replacement two"} {
		tmp := file + ".tmp"
		if err := os.WriteFile(tmp, []byte(contents), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(tmp, file); err != nil {
			t.Fatal(err)
		}
		deadline := time.NewTimer(time.Minute)
		found := false
		for !found {
			select {
			case seen := <-notified:
				found = seen == contents
			case <-deadline.C:
				t.Fatal("atomic replacement was not reported")
			}
		}
		deadline.Stop()
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestModWatcherDoesNotFollowSymlinkDirectories(t *testing.T) {
	base := t.TempDir()
	mods := filepath.Join(base, "mods")
	mod := filepath.Join(mods, "example")
	outside := filepath.Join(base, "outside")
	for _, dir := range []string{mod, outside} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(mod, "main.js")
	if err := os.WriteFile(file, []byte("before"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, link := range []struct{ name, target string }{
		{"linked", outside}, {"dangling", filepath.Join(base, "missing")},
	} {
		if err := os.Symlink(link.target, filepath.Join(mod, link.name)); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
	}
	w, err := MakeModWatcher(mods, filepath.Join(base, "state", StateFileName), filepath.Join(base, "trust", TrustFileName), time.Hour, func([]string) {})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	modWatched := false
	for _, watched := range w.watcher.WatchList() {
		if watched == mod {
			modWatched = true
		}
		if watched == outside || watched == filepath.Join(mod, "linked") || watched == filepath.Join(mod, "dangling") {
			t.Fatalf("watched a symlink target: %s", watched)
		}
	}
	if !modWatched {
		t.Fatal("a dangling symlink prevented the mod directory from being watched")
	}
	if err := os.WriteFile(file, []byte("after"), 0644); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(time.Minute)
	defer deadline.Stop()
	for {
		select {
		case event, ok := <-w.watcher.Events:
			if !ok {
				t.Fatal("watcher events closed before the file edit")
			}
			if filepath.Clean(event.Name) == file {
				return
			}
		case err, ok := <-w.watcher.Errors:
			if !ok {
				t.Fatal("watcher errors closed before the file edit")
			}
			t.Fatal(err)
		case <-deadline.C:
			t.Fatal("mod file edit was not reported with a dangling symlink present")
		}
	}
}
