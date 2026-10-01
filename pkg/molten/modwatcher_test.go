// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestModIdForPath(t *testing.T) {
	modsDir := filepath.Join("/cfg", "mods")
	cases := map[string]string{
		filepath.Join(modsDir, "greet"):                 "greet",
		filepath.Join(modsDir, "greet", "main.js"):      "greet",
		filepath.Join(modsDir, "greet", "lib", "x.js"):  "greet",
		filepath.Join(modsDir, "greet", ".main.js.swp"): "",
		filepath.Join(modsDir, "greet", "main.js~"):     "",
		filepath.Join(modsDir, "greet", "mod.json.tmp"): "",
		filepath.Join(modsDir, ".hidden", "main.js"):    "",
		modsDir: "",
		filepath.Join("/cfg", "other", "main.js"): "",
		filepath.Join("/cfg", "modsx", "a"):       "",
	}
	for path, want := range cases {
		got, ok := ModIdForPath(modsDir, path)
		if got != want || ok != (want != "") {
			t.Errorf("ModIdForPath(%q) = %q, %v; want %q", path, got, ok, want)
		}
	}
}

func TestDiffSnapshots(t *testing.T) {
	prev := map[string]string{"a": "enabled,trusted", "b": "enabled", "c": "disabled"}
	next := map[string]string{"a": "enabled,trusted", "b": "enabled,trusted", "d": "enabled"}
	got := strings.Join(diffSnapshots(prev, next), ",")
	if got != "b,c,d" {
		t.Fatalf("diffSnapshots = %q, want b,c,d", got)
	}
}

type publishRecorder struct {
	lock  sync.Mutex
	calls [][]string
}

func (r *publishRecorder) publish(ids []string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.calls = append(r.calls, ids)
}

func (r *publishRecorder) take() [][]string {
	r.lock.Lock()
	defer r.lock.Unlock()
	calls := r.calls
	r.calls = nil
	return calls
}

// Waits for the debounced publications of one burst of file changes.
func (r *publishRecorder) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	got := ""
	for time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		calls := r.take()
		for _, ids := range calls {
			if got != "" {
				got += " | "
			}
			got += strings.Join(ids, ",")
		}
		if got == want {
			time.Sleep(150 * time.Millisecond)
			if extra := r.take(); len(extra) > 0 {
				t.Fatalf("got %q, then unexpected %v", got, extra)
			}
			return
		}
	}
	t.Fatalf("published %q, want %q", got, want)
}

func TestModWatcherOnDisk(t *testing.T) {
	configDir := t.TempDir()
	dataDir := t.TempDir()
	modsDir := filepath.Join(configDir, "mods")
	stateFile := filepath.Join(configDir, "molten", StateFileName)
	trustFile := filepath.Join(dataDir, "molten", TrustFileName)
	os.MkdirAll(filepath.Join(modsDir, "greet"), 0755)
	os.WriteFile(filepath.Join(modsDir, "greet", "main.js"), []byte("v1"), 0644)

	rec := &publishRecorder{}
	mw, err := MakeModWatcher(modsDir, stateFile, trustFile, 100*time.Millisecond, rec.publish)
	if err != nil {
		t.Fatal(err)
	}
	defer mw.Close()
	go mw.Run()

	// One burst, as an editor saves: write a temp file, rename it over main.js, touch mod.json.
	tmp := filepath.Join(modsDir, "greet", "main.js.tmp")
	os.WriteFile(tmp, []byte("v2"), 0644)
	os.Rename(tmp, filepath.Join(modsDir, "greet", "main.js"))
	os.WriteFile(filepath.Join(modsDir, "greet", "mod.json"), []byte("{}"), 0644)
	rec.waitFor(t, "greet")

	// A new mod with a nested folder: the folder is watched as soon as it appears.
	os.MkdirAll(filepath.Join(modsDir, "fresh", "lib"), 0755)
	rec.waitFor(t, "fresh")
	time.Sleep(50 * time.Millisecond)
	os.WriteFile(filepath.Join(modsDir, "fresh", "lib", "util.js"), []byte("x"), 0644)
	rec.waitFor(t, "fresh")

	// Only the mods whose state changed reload; rewriting the same state reloads nothing.
	writeAtomic(t, stateFile, `{"enabled":["greet","fresh"]}`)
	rec.waitFor(t, "fresh,greet")
	writeAtomic(t, trustFile, `{"trusted":{"greet":{"name":"Greet"}}}`)
	rec.waitFor(t, "greet")
	writeAtomic(t, stateFile, `{"enabled":["fresh","greet"]}`)
	time.Sleep(400 * time.Millisecond)
	if calls := rec.take(); len(calls) > 0 {
		t.Fatalf("an unchanged state must reload nothing, got %v", calls)
	}

	os.RemoveAll(filepath.Join(modsDir, "fresh"))
	rec.waitFor(t, "fresh")
}

func writeAtomic(t *testing.T, path string, content string) {
	t.Helper()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
}
