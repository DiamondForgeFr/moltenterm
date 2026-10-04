// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

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
