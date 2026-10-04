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

// FR-MORPH-010: Claude Code writes its typings into the part's `.claude-plugin/types/` at every load; they must
// neither reload the mod nor be recorded, while the part's own files reload it.
func TestModWatcherClaudeCodePart(t *testing.T) {
	configDir := t.TempDir()
	dataDir := t.TempDir()
	modsDir := filepath.Join(configDir, "mods")
	part := filepath.Join(modsDir, "band", "agents", "claude-code")
	os.MkdirAll(filepath.Join(part, ".claude-plugin"), 0755)
	os.MkdirAll(filepath.Join(part, "hooks"), 0755)
	os.WriteFile(filepath.Join(part, ".claude-plugin", "plugin.json"), []byte(`{"name":"band"}`), 0644)

	rec := &publishRecorder{}
	mw, err := MakeModWatcher(modsDir, filepath.Join(configDir, "molten", StateFileName), filepath.Join(dataDir, "molten", TrustFileName), 100*time.Millisecond, rec.publish)
	if err != nil {
		t.Fatal(err)
	}
	defer mw.Close()
	go mw.Run()

	os.MkdirAll(filepath.Join(part, ".claude-plugin", "types", "claude-code"), 0755)
	time.Sleep(50 * time.Millisecond)
	os.WriteFile(filepath.Join(part, ".claude-plugin", "types", "claude-code", "index.d.ts"), []byte("x"), 0644)
	time.Sleep(400 * time.Millisecond)
	if calls := rec.take(); len(calls) > 0 {
		t.Fatalf("Claude Code's typings must not reload the mod, got %v", calls)
	}

	os.WriteFile(filepath.Join(part, ".claude-plugin", "plugin.json"), []byte(`{"name":"band","version":"2"}`), 0644)
	rec.waitFor(t, "band")
	os.WriteFile(filepath.Join(part, "hooks", "register.ts"), []byte("x"), 0644)
	rec.waitFor(t, "band")
}

func TestModIdForPathInAPart(t *testing.T) {
	modsDir := filepath.Join("/cfg", "mods")
	part := filepath.Join(modsDir, "band", "agents", "claude-code")
	cases := map[string]string{
		filepath.Join(part, ".claude-plugin", "plugin.json"):                      "band",
		filepath.Join(part, ".claude-plugin"):                                     "band",
		filepath.Join(part, ".claude-plugin", "types"):                            "",
		filepath.Join(part, ".claude-plugin", "types", "claude-code", "index.ts"): "",
	}
	for path, want := range cases {
		got, ok := ModIdForPath(modsDir, path)
		if got != want || ok != (want != "") {
			t.Errorf("ModIdForPath(%q) = %q, %v; want %q", path, got, ok, want)
		}
	}
}

func TestStateSnapshotMarksThePartTrust(t *testing.T) {
	trustFile := filepath.Join(t.TempDir(), TrustFileName)
	mw := &ModWatcher{stateFile: filepath.Join(t.TempDir(), StateFileName), trustFile: trustFile}
	os.WriteFile(trustFile, []byte(`{"trusted":{"a":{"name":"A"},"b":{"name":"B","agents":["claude-code"]}}}`), 0644)
	snapshot := mw.readStateSnapshot()
	if snapshot["a"] != "trusted" || snapshot["b"] != "trusted,trusted:claude-code" {
		t.Fatalf("snapshot %v", snapshot)
	}
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
