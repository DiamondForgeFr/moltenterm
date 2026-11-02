// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func requireUnixModes(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not support Unix executable permission bits")
	}
}

func assertFileMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %04o, want %04o", path, got, want)
	}
}

func TestHistoryPreservesRegularFilePermissions(t *testing.T) {
	requireUnixModes(t)
	for _, mode := range []os.FileMode{0755, 0644, 0600, 0700, 0400} {
		t.Run(fmt.Sprintf("%04o", mode), func(t *testing.T) {
			f := makeHistoryFixture(t)
			helper := "m/agents/claude-code/hooks/helper.sh"
			f.write(helper, "#!/bin/sh\nexit 0\n")
			path := filepath.Join(f.modsDir, helper)
			if err := os.Chmod(path, mode); err != nil {
				t.Fatal(err)
			}
			f.write("m/main.js", "v1")
			f.setState(`{"enabled":["m"]}`)
			f.record(HistoryKindStart)
			assertFileMode(t, filepath.Join(f.h.Dir, "1", historyModsDir, helper), mode)
			f.write("m/main.js", "v2")
			f.setState(`{"disabled":["m"]}`)
			f.record(HistoryKindChange, "m")
			f.write("m/main.js", "v3")
			f.record(HistoryKindChange, "m")
			for _, want := range []string{"v2", "v1"} {
				f.undo()
				assertFileMode(t, path, mode)
				if got := f.read("m/main.js"); got != want {
					t.Fatalf("main.js = %q, want %q", got, want)
				}
			}
			state, err := os.ReadFile(f.stateFile)
			if err != nil || string(state) != `{"enabled":["m"]}` {
				t.Fatalf("restored enabled state = %s, err = %v", state, err)
			}
		})
	}
}

func TestHistoryPermissionOnlyChanges(t *testing.T) {
	requireUnixModes(t)
	f := makeHistoryFixture(t)
	f.write("m/helper.sh", "unchanged")
	f.setState(`{"enabled":["m"]}`)
	path := filepath.Join(f.modsDir, "m/helper.sh")
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	f.record(HistoryKindStart)
	for _, mode := range []os.FileMode{0755, 0600} {
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		if !f.record(HistoryKindChange, "m") || f.record(HistoryKindChange, "m") {
			t.Fatal("a permission-only change must record exactly once")
		}
	}
	for _, mode := range []os.FileMode{0755, 0644} {
		f.undo()
		assertFileMode(t, path, mode)
		if f.read("m/helper.sh") != "unchanged" {
			t.Fatal("permission undo changed the content")
		}
	}
	if err := os.Chmod(f.stateFile, 0600); err != nil {
		t.Fatal(err)
	}
	if f.record(HistoryKindChange, "m") {
		t.Fatal("state file permissions are not snapshot identity")
	}
}

func TestHistoryRestoreCopyFailureKeepsOriginal(t *testing.T) {
	requireUnixModes(t)
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory write permissions")
	}
	f := makeHistoryFixture(t)
	f.write("m/main.js", "v1")
	f.record(HistoryKindStart)
	f.write("m/main.js", "v2")
	f.record(HistoryKindChange, "m")
	if err := os.Chmod(f.modsDir, 0555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(f.modsDir, 0755) })
	if _, _, err := f.h.Undo(f.now); err == nil {
		t.Fatal("undo must report the staging copy failure")
	}
	if f.read("m/main.js") != "v2" {
		t.Fatal("a failed staging copy must leave the original mod intact")
	}
	entries, err := f.h.Entries()
	if err != nil || len(entries) != 2 {
		t.Fatalf("failed undo recorded history: %v, %v", entries, err)
	}
	children, err := os.ReadDir(f.modsDir)
	if err != nil || len(children) != 1 || children[0].Name() != "m" {
		t.Fatalf("failed staging copy left files: %v, %v", children, err)
	}
}

func TestHistoryRestoreCopyFailureCleansStaging(t *testing.T) {
	requireUnixModes(t)
	if os.Geteuid() == 0 {
		t.Skip("root bypasses file read permissions")
	}
	f := makeHistoryFixture(t)
	f.write("m/a.js", "copied first")
	f.write("m/z.js", "unreadable later")
	f.record(HistoryKindStart)
	if err := os.RemoveAll(filepath.Join(f.modsDir, "m")); err != nil {
		t.Fatal(err)
	}
	f.record(HistoryKindChange, "m")
	if err := os.Chmod(filepath.Join(f.h.Dir, "1", historyModsDir, "m/z.js"), 0000); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.h.Undo(f.now); err == nil {
		t.Fatal("undo must report an unreadable snapshot file")
	}
	children, err := os.ReadDir(f.modsDir)
	if err != nil || len(children) != 0 {
		t.Fatalf("failed copy left a partial mod or staging folder: %v, %v", children, err)
	}
	entries, err := f.h.Entries()
	if err != nil || len(entries) != 2 {
		t.Fatalf("failed copy recorded history: %v, %v", entries, err)
	}
}

type historyFixture struct {
	t         *testing.T
	h         *History
	modsDir   string
	stateFile string
	now       time.Time
}

func makeHistoryFixture(t *testing.T) *historyFixture {
	configDir := t.TempDir()
	modsDir := filepath.Join(configDir, "mods")
	stateFile := filepath.Join(configDir, "molten", StateFileName)
	os.MkdirAll(modsDir, 0755)
	return &historyFixture{
		t:         t,
		h:         MakeHistory(filepath.Join(t.TempDir(), "history"), modsDir, stateFile),
		modsDir:   modsDir,
		stateFile: stateFile,
		now:       time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC),
	}
}

func (f *historyFixture) write(rel string, content string) {
	path := filepath.Join(f.modsDir, rel)
	os.MkdirAll(filepath.Dir(path), 0755)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *historyFixture) setState(content string) {
	os.MkdirAll(filepath.Dir(f.stateFile), 0755)
	os.WriteFile(f.stateFile, []byte(content), 0644)
}

func (f *historyFixture) record(kind string, ids ...string) bool {
	f.now = f.now.Add(time.Minute)
	recorded, err := f.h.Record(kind, ids, 0, f.now)
	if err != nil {
		f.t.Fatal(err)
	}
	return recorded
}

func (f *historyFixture) read(rel string) string {
	data, err := os.ReadFile(filepath.Join(f.modsDir, rel))
	if err != nil {
		return "<missing>"
	}
	return string(data)
}

func (f *historyFixture) undo() HistoryEntry {
	f.now = f.now.Add(time.Minute)
	target, _, err := f.h.Undo(f.now)
	if err != nil {
		f.t.Fatal(err)
	}
	return target
}

// TC-MORPH-003: enable a mod, edit it twice, undo twice: the mod is back as first enabled.
func TestHistoryUndoStepsBack(t *testing.T) {
	f := makeHistoryFixture(t)
	f.record(HistoryKindStart)
	f.write("greet/main.js", "v1")
	f.setState(`{"enabled":["greet"]}`)
	f.record(HistoryKindChange, "greet")
	f.write("greet/main.js", "v2")
	f.record(HistoryKindChange, "greet")
	f.write("greet/main.js", "v3")
	f.record(HistoryKindChange, "greet")

	if target := f.undo(); target.Seq != 3 || f.read("greet/main.js") != "v2" {
		t.Fatalf("first undo restored #%d, main.js = %q", target.Seq, f.read("greet/main.js"))
	}
	if target := f.undo(); target.Seq != 2 || f.read("greet/main.js") != "v1" {
		t.Fatalf("second undo restored #%d, main.js = %q", target.Seq, f.read("greet/main.js"))
	}
	state, _ := os.ReadFile(f.stateFile)
	if string(state) != `{"enabled":["greet"]}` {
		t.Fatalf("the enabled state must come back too: %s", state)
	}
	if target := f.undo(); target.Seq != 1 || f.read("greet/main.js") != "<missing>" {
		t.Fatalf("third undo restored #%d, main.js = %q", target.Seq, f.read("greet/main.js"))
	}
	entries, _ := f.h.Entries()
	if last := entries[len(entries)-1]; strings.Join(last.Ids, ",") != "greet" {
		t.Fatalf("an undo names the mods whose enabled state it changed: %+v", last)
	}
	if _, _, err := f.h.Undo(f.now); err == nil || !strings.Contains(err.Error(), "nothing to undo") {
		t.Fatalf("undo past the start must stop, got %v", err)
	}
	entries, _ = f.h.Entries()
	kinds := []string{}
	for _, e := range entries {
		kinds = append(kinds, e.Kind)
	}
	if strings.Join(kinds, ",") != "start,change,change,change,undo,undo,undo" {
		t.Fatalf("history kinds: %v", kinds)
	}
}

func TestHistoryUndoAfterNewEdit(t *testing.T) {
	f := makeHistoryFixture(t)
	f.write("m/main.js", "a")
	f.record(HistoryKindStart)
	f.write("m/main.js", "b")
	f.record(HistoryKindChange, "m")
	f.undo() // back to a
	f.write("m/main.js", "c")
	f.record(HistoryKindChange, "m")
	if f.undo(); f.read("m/main.js") != "a" {
		t.Fatalf("undoing an edit made after an undo returns to the state before that edit, got %q", f.read("m/main.js"))
	}
}

func TestHistoryRecordSkipsUnchangedAndMarker(t *testing.T) {
	f := makeHistoryFixture(t)
	f.write("m/main.js", "a")
	if !f.record(HistoryKindStart) {
		t.Fatal("the first snapshot is recorded")
	}
	if f.record(HistoryKindChange, "m") {
		t.Fatal("an unchanged tree is not recorded")
	}
	f.write("m/.main.js.swp", "editor")
	f.write("m/main.js~", "backup")
	if f.record(HistoryKindChange, "m") {
		t.Fatal("editor files do not count as a change")
	}
	os.MkdirAll(f.h.Dir, 0755)
	os.WriteFile(filepath.Join(f.h.Dir, historyRestoringMarker), []byte("1"), 0644)
	f.write("m/main.js", "b")
	if f.record(HistoryKindChange, "m") {
		t.Fatal("nothing is recorded while an undo restores files")
	}
}

func TestHistoryKeepsTheLast50(t *testing.T) {
	f := makeHistoryFixture(t)
	for i := 0; i < HistoryKeep+5; i++ {
		f.write("m/main.js", strings.Repeat("x", i+1))
		f.record(HistoryKindChange, "m")
	}
	entries, _ := f.h.Entries()
	if len(entries) != HistoryKeep || entries[0].Seq != 6 {
		t.Fatalf("kept %d entries starting at #%d", len(entries), entries[0].Seq)
	}
}

func TestHistoryRestoreRemovesAddedMods(t *testing.T) {
	f := makeHistoryFixture(t)
	f.write("keep/main.js", "k")
	f.record(HistoryKindStart)
	f.write("added/main.js", "new")
	f.record(HistoryKindChange, "added")
	_, undoEntry, err := f.h.Undo(f.now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if f.read("added/main.js") != "<missing>" || f.read("keep/main.js") != "k" {
		t.Fatal("undo must remove the mod added by the undone change and keep the others")
	}
	if strings.Join(undoEntry.Ids, ",") != "added" || undoEntry.Target != 1 {
		t.Fatalf("the undo entry names what it changed: %+v", undoEntry)
	}
	if entries, _ := os.ReadDir(f.modsDir); len(entries) != 1 {
		t.Fatalf("no temporary folder may stay behind: %v", entries)
	}
}

// FR-MORPH-010: an undo restores a Claude Code part whole, its `.claude-plugin/plugin.json` included, and the
// typings Claude Code lays in `.claude-plugin/types/` are not part of the history.
func TestHistoryKeepsTheClaudeCodePart(t *testing.T) {
	f := makeHistoryFixture(t)
	part := "band/agents/claude-code/"
	f.write("band/mod.json", "{}")
	f.write(part+".claude-plugin/plugin.json", `{"name":"band"}`)
	f.write(part+"hooks/register.tsx", "v1")
	f.write(part+".gitignore", ".claude-plugin/types/\n")
	f.record(HistoryKindStart)

	f.write(part+".claude-plugin/types/claude-code/index.d.ts", "typings")
	if f.record(HistoryKindChange, "band") {
		t.Fatal("Claude Code's typings must not be recorded as a change")
	}

	f.write(part+"hooks/register.tsx", "v2")
	if !f.record(HistoryKindChange, "band") {
		t.Fatal("an edit of the part must be recorded")
	}
	f.undo()
	if got := f.read(part + "hooks/register.tsx"); got != "v1" {
		t.Fatalf("register.tsx after undo: %q", got)
	}
	if got := f.read(part + ".claude-plugin/plugin.json"); got != `{"name":"band"}` {
		t.Fatalf("plugin.json after undo: %q", got)
	}
	if got := f.read(part + ".gitignore"); got != ".claude-plugin/types/\n" {
		t.Fatalf(".gitignore after undo: %q", got)
	}
}

func historyTestSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlink creation requires privileges: %v", err)
		}
		t.Fatal(err)
	}
}

func TestHistoryRejectsIncludedSymlinks(t *testing.T) {
	for _, rel := range []string{"m/helper", "m/inward", "m/linked-dir", "m/broken", "m/.mcp.json", "m/.lsp.json", "m/.gitignore", "m/agents/claude-code/.claude-plugin", "m/agents/claude-code/.claude-plugin/plugin.json"} {
		t.Run(rel, func(t *testing.T) {
			f := makeHistoryFixture(t)
			f.write("m/main.js", "original")
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.WriteFile(outside, []byte("sentinel"), 0600); err != nil {
				t.Fatal(err)
			}
			target := outside
			if rel == "m/linked-dir" {
				target = filepath.Dir(outside)
			} else if rel == "m/inward" {
				target = filepath.Join(f.modsDir, "m/main.js")
			} else if rel == "m/broken" {
				target += ".missing"
			}
			historyTestSymlink(t, target, filepath.Join(f.modsDir, rel))
			if _, err := f.h.Record(HistoryKindStart, nil, 0, f.now); err == nil {
				t.Fatal("included links must fail recording")
			}
			if entries, err := f.h.Entries(); err != nil || len(entries) != 0 {
				t.Fatalf("failed record created an entry: %v, %v", entries, err)
			}
			if data, err := os.ReadFile(outside); err != nil || string(data) != "sentinel" {
				t.Fatalf("outside file changed: %q, %v", data, err)
			}
		})
	}
}

func TestHistoryIgnoredSymlinksStayIgnored(t *testing.T) {
	f := makeHistoryFixture(t)
	f.write("m/main.js", "original")
	f.write("m/agents/claude-code/.claude-plugin/plugin.json", "{}")
	f.record(HistoryKindStart)
	for _, rel := range []string{"m/.editor", "m/editor~", "m/editor.swp", "m/editor.tmp", "m/agents/claude-code/.claude-plugin/types"} {
		historyTestSymlink(t, t.TempDir(), filepath.Join(f.modsDir, rel))
	}
	if f.record(HistoryKindChange, "m") {
		t.Fatal("ignored symlinks must not change snapshot identity")
	}
}

func TestHistoryRejectsUnsafeRootsAndState(t *testing.T) {
	for _, location := range []string{"mods", "history", "state", "state-parent", "broken-state", "marker"} {
		t.Run(location, func(t *testing.T) {
			f := makeHistoryFixture(t)
			f.write("m/main.js", "original")
			f.setState(`{"enabled":["m"]}`)
			f.record(HistoryKindStart)
			var link string
			switch location {
			case "mods":
				link = f.modsDir
			case "history":
				link = f.h.Dir
			case "state", "broken-state":
				link = f.stateFile
			case "state-parent":
				link = filepath.Dir(f.stateFile)
			case "marker":
				link = filepath.Join(f.h.Dir, historyRestoringMarker)
				if err := os.WriteFile(link, []byte("old"), 0644); err != nil {
					t.Fatal(err)
				}
			}
			target := link + ".original"
			if err := os.Rename(link, target); err != nil {
				t.Fatal(err)
			}
			if location == "broken-state" {
				target += ".missing"
			}
			historyTestSymlink(t, target, link)
			if _, err := f.h.Record(HistoryKindChange, nil, 0, f.now); err == nil {
				t.Fatal("managed links must fail even when content is otherwise unchanged")
			}
			if _, _, err := f.h.Undo(f.now); err == nil {
				t.Fatal("managed links must fail undo")
			}
			if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
				t.Fatalf("rejected operation changed the link: %v, %v", info, err)
			}
		})
	}
}

func TestHistoryRestorePreflightKeepsAllMods(t *testing.T) {
	for _, corruption := range []string{"later-mod", "snapshot-state", "current-state", "snapshot-root", "snapshot-mods", "missing-mods", "current-file"} {
		t.Run(corruption, func(t *testing.T) {
			f := makeHistoryFixture(t)
			f.write("a/main.js", "a1")
			f.write("z/main.js", "z1")
			f.setState(`{"enabled":["a"]}`)
			f.record(HistoryKindStart)
			f.write("a/main.js", "a2")
			f.write("z/main.js", "z2")
			f.write("added/main.js", "must survive")
			f.setState(`{"enabled":["z"]}`)
			f.record(HistoryKindChange, "a", "z", "added")
			snapshot := filepath.Join(f.h.Dir, "1")
			var unsafe string
			switch corruption {
			case "later-mod":
				unsafe = filepath.Join(snapshot, historyModsDir, "z/main.js")
			case "snapshot-state":
				unsafe = filepath.Join(snapshot, StateFileName)
			case "current-state":
				unsafe = f.stateFile
			case "snapshot-root":
				unsafe = snapshot
			case "snapshot-mods", "missing-mods":
				unsafe = filepath.Join(snapshot, historyModsDir)
			case "current-file":
				unsafe = filepath.Join(f.modsDir, "z/unsafe")
			}
			if err := os.RemoveAll(unsafe); err != nil {
				t.Fatal(err)
			}
			if corruption != "missing-mods" {
				historyTestSymlink(t, filepath.Join(t.TempDir(), "missing"), unsafe)
			}
			if runtime.GOOS != "windows" {
				if err := os.Chmod(filepath.Join(f.modsDir, "a/main.js"), 0755); err != nil {
					t.Fatal(err)
				}
			}
			modes := make(map[string]os.FileMode)
			for _, rel := range []string{"a/main.js", "z/main.js", "added/main.js"} {
				info, err := os.Stat(filepath.Join(f.modsDir, rel))
				if err != nil {
					t.Fatal(err)
				}
				modes[rel] = info.Mode().Perm()
			}
			beforeEntries, err := os.ReadDir(f.h.Dir)
			if err != nil {
				t.Fatal(err)
			}
			metadata := make(map[string]string)
			for _, seq := range []string{"1", "2"} {
				file := filepath.Join(f.h.Dir, seq, historyEntryFile)
				if data, err := os.ReadFile(file); err == nil {
					metadata[file] = string(data)
				}
			}
			stateLink := ""
			if corruption == "current-state" {
				stateLink, err = os.Readlink(f.stateFile)
				if err != nil {
					t.Fatal(err)
				}
			}
			if _, _, err := f.h.Undo(f.now); err == nil {
				t.Fatal("unsafe complete restore plan must fail")
			}
			for rel, want := range map[string]string{"a/main.js": "a2", "z/main.js": "z2", "added/main.js": "must survive"} {
				if got := f.read(rel); got != want {
					t.Fatalf("preflight failure changed %s: %q", rel, got)
				}
				assertFileMode(t, filepath.Join(f.modsDir, rel), modes[rel])
			}
			if corruption == "current-state" {
				if link, err := os.Readlink(f.stateFile); err != nil || link != stateLink {
					t.Fatalf("preflight changed state link: %q, %v", link, err)
				}
			} else if data, err := os.ReadFile(f.stateFile); err != nil || string(data) != `{"enabled":["z"]}` {
				t.Fatalf("preflight changed enabled state: %q, %v", data, err)
			}
			afterEntries, err := os.ReadDir(f.h.Dir)
			if err != nil || fmt.Sprint(afterEntries) != fmt.Sprint(beforeEntries) {
				t.Fatalf("preflight changed history entries: %v, %v", afterEntries, err)
			}
			for file, want := range metadata {
				if data, err := os.ReadFile(file); err != nil || string(data) != want {
					t.Fatalf("preflight changed history metadata: %s, %v", file, err)
				}
			}
			if _, err := os.Lstat(filepath.Join(f.h.Dir, historyRestoringMarker)); !os.IsNotExist(err) {
				t.Fatalf("preflight wrote a restoring marker: %v", err)
			}
			children, err := os.ReadDir(f.modsDir)
			if err != nil || len(children) != 3 {
				t.Fatalf("preflight left staging files: %v, %v", children, err)
			}
		})
	}
}

func TestHistoryRegularHashCompatibility(t *testing.T) {
	requireUnixModes(t)
	f := makeHistoryFixture(t)
	f.write("m/main.js", "old")
	if err := os.Chmod(filepath.Join(f.modsDir, "m/main.js"), 0644); err != nil {
		t.Fatal(err)
	}
	hash, err := f.h.currentHash()
	if err != nil || hash != "483d19f2cc1d339c711701724b7259a9b0ca45ec88a32dddfb2acace23c90fb4" {
		t.Fatalf("ordinary file hash no longer matches the existing format: %s, %v", hash, err)
	}
}

func TestHistoryRejectsMismatchedMetadataSequence(t *testing.T) {
	for _, seq := range []int{0, -1, 20} {
		t.Run(fmt.Sprint(seq), func(t *testing.T) {
			f := makeHistoryFixture(t)
			f.write("m/main.js", "keep")
			f.record(HistoryKindStart)
			file := filepath.Join(f.h.Dir, "1", historyEntryFile)
			if err := os.WriteFile(file, []byte(fmt.Sprintf(`{"seq":%d,"kind":"start"}`, seq)), 0644); err != nil {
				t.Fatal(err)
			}
			if _, err := f.h.Entries(); err == nil {
				t.Fatal("mismatched metadata sequence must fail")
			}
			if _, _, err := f.h.Undo(f.now); err == nil || f.read("m/main.js") != "keep" {
				t.Fatalf("corrupt metadata must not restore anything: %v", err)
			}
		})
	}
}

func TestHistoryLegacyStateAndUnownedTemporaryPaths(t *testing.T) {
	f := makeHistoryFixture(t)
	f.write("m/main.js", "old")
	f.record(HistoryKindStart) // Old snapshots may have no mods.json.
	f.write("m/main.js", "new")
	f.setState(`{"enabled":["m"]}`)
	f.record(HistoryKindChange, "m")
	f.write(".restore-m/sentinel", "unowned mod staging")
	stateTmp := f.stateFile + ".tmp"
	if err := os.WriteFile(stateTmp, []byte("unowned state staging"), 0600); err != nil {
		t.Fatal(err)
	}
	f.undo()
	if f.read("m/main.js") != "old" || f.read(".restore-m/sentinel") != "unowned mod staging" {
		t.Fatal("restore changed the wrong files")
	}
	if data, err := os.ReadFile(f.stateFile); err != nil || string(data) != "{\"enabled\": []}\n" {
		t.Fatalf("legacy enabled state = %q, %v", data, err)
	}
	if data, err := os.ReadFile(stateTmp); err != nil || string(data) != "unowned state staging" {
		t.Fatalf("restore changed unowned state staging: %q, %v", data, err)
	}
	if _, err := os.Lstat(filepath.Join(f.h.Dir, historyRestoringMarker)); !os.IsNotExist(err) {
		t.Fatalf("successful undo left its marker: %v", err)
	}
}
