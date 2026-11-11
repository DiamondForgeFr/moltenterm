// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func makeTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Brainstorms")
	return MakeStore(func() string { return root }, filepath.Join(t.TempDir(), "data")), root
}

func TestSlugIsAFolderName(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"A safe video app for children":         "a-safe-video-app-for-children",
		"Une app vidéo sûre pour les enfants !": "une-app-video-sure-pour-les-enfants",
		"../../etc/passwd":                      "etc-passwd",
		"  Œuvre   Façade  ":                    "oeuvre-facade",
		"日本語":                                   "idea",
		"":                                      "idea",
		strings.Repeat("long ", 30):             strings.TrimRight(strings.Repeat("long-", 10)[:48], "-"),
	}
	for title, want := range cases {
		if got := Slug(title); got != want {
			t.Errorf("Slug(%q) = %q, want %q", title, got, want)
		}
		if strings.ContainsAny(Slug(title), "/\\.") {
			t.Errorf("Slug(%q) can reach another folder", title)
		}
	}
}

// FR-BOSS-010 AC7 (#2246): one folder per idea, made exclusively: the same title gets the next free name.
func TestCreateNeverSharesAFolder(t *testing.T) {
	t.Parallel()
	store, root := makeTestStore(t)
	first, err := store.Create("Forge notes", 1)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Create("Forge notes", 2)
	if err != nil {
		t.Fatal(err)
	}
	if first.Dir != filepath.Join(root, "forge-notes") || second.Dir != filepath.Join(root, "forge-notes-2") {
		t.Errorf("folders %s and %s", first.Dir, second.Dir)
	}
	if first.Info.Id == second.Info.Id || first.Info.State != StateOpen || first.Info.Source != SourceBrokk {
		t.Errorf("infos %+v and %+v", first.Info, second.Info)
	}
}

// AC7: what is saved reads back the same, and the writes leave no temporary file behind.
func TestSaveThenLoadGivesTheSameBrainstorm(t *testing.T) {
	t.Parallel()
	store, _ := makeTestStore(t)
	saved, err := store.Create("A safe video app for children", 1000)
	if err != nil {
		t.Fatal(err)
	}
	saved.Graph = sampleGraph(t)
	saved.Turns = []Turn{
		{Turn: 1, At: 1000, Role: RoleYou, Text: "An app idea:\nvideos for kids"},
		{Turn: 1, At: 1000, Role: RoleBrokk, Text: "Let's put it on the anvil."},
	}
	for i := 0; i < 2; i++ {
		if err := store.Save(saved); err != nil {
			t.Fatal(err)
		}
	}
	back, err := store.Load(saved.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, saved) {
		t.Errorf("loaded\n%+v\nwant\n%+v", back, saved)
	}
	entries, err := os.ReadDir(saved.Dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if !reflect.DeepEqual(names, []string{InfoFile, ConversationFile, GraphFile}) {
		t.Errorf("the folder holds %v", names)
	}
	lines := strings.Split(strings.TrimSpace(readText(t, filepath.Join(saved.Dir, ConversationFile))), "\n")
	if len(lines) != 2 {
		t.Errorf("conversation.jsonl holds %d lines, want one per turn", len(lines))
	}
}

func readText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestARenameReplacesTheFileWhole(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, GraphFile)
	if err := writeAtomic(path, []byte("old")); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(path, []byte("new")); err != nil {
		t.Fatal(err)
	}
	if got := readText(t, path); got != "new" {
		t.Errorf("the file holds %q", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("the file's mode is %v", info.Mode().Perm())
	}
}

// The open brainstorm is remembered in MoltenTerm's own folder, and a folder that is gone is not resumed.
func TestCurrentIsRememberedAcrossARestart(t *testing.T) {
	t.Parallel()
	store, _ := makeTestStore(t)
	if _, ok := store.Current(); ok {
		t.Fatal("a brainstorm is current before any")
	}
	saved, err := store.Create("Forge notes", 1)
	if err != nil {
		t.Fatal(err)
	}
	saved.Graph = sampleGraph(t)
	if err := store.Save(saved); err != nil {
		t.Fatal(err)
	}
	if err := store.Remember(saved.Dir); err != nil {
		t.Fatal(err)
	}
	restarted := MakeStore(store.root, store.stateDir)
	back, ok := restarted.Current()
	if !ok || !reflect.DeepEqual(back.Graph, saved.Graph) {
		t.Fatalf("after a restart: %v %+v", ok, back.Graph)
	}
	if err := os.RemoveAll(saved.Dir); err != nil {
		t.Fatal(err)
	}
	if _, ok := restarted.Current(); ok {
		t.Error("a deleted folder is still current")
	}
}

func TestABrokenGraphDoesNotLoad(t *testing.T) {
	t.Parallel()
	store, _ := makeTestStore(t)
	saved, err := store.Create("Forge notes", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save(saved); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(saved.Dir, GraphFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(saved.Dir); err == nil {
		t.Error("a broken graph.json loaded")
	}
}

func TestBrainstormsDirFollowsTheSetting(t *testing.T) {
	t.Parallel()
	home := filepath.FromSlash("/home/dev")
	cases := map[string]string{
		"":        filepath.Join(home, "MoltenTerm", "Brainstorms"),
		"  ":      filepath.Join(home, "MoltenTerm", "Brainstorms"),
		"~":       home,
		"~/Ideas": filepath.Join(home, "Ideas"),
		"Ideas":   filepath.Join(home, "Ideas"),
	}
	if abs := t.TempDir(); BrainstormsDir(filepath.Join(abs, "ideas", ".."), home) != abs {
		t.Errorf("an absolute folder is not taken as it is")
	}
	for setting, want := range cases {
		if got := BrainstormsDir(setting, home); got != want {
			t.Errorf("BrainstormsDir(%q) = %q, want %q", setting, got, want)
		}
	}
}
