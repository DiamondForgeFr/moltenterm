// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The folders of #2248 (FR-BOSS-010 AC10, AC10a to AC10d, AC11): synthetic brainstorms in temporary folders, a trash
// of the test's own.

var errTestNoTrash = errors.New("no trash in this test")

// testTrash moves a folder into a trash folder of the test, as the system's would.
func testTrash(t *testing.T, store *Store) string {
	t.Helper()
	trash := filepath.Join(t.TempDir(), "Trash")
	if err := os.MkdirAll(trash, 0o700); err != nil {
		t.Fatal(err)
	}
	store.UseTrash(func(path string) (string, error) {
		dest := filepath.Join(trash, filepath.Base(path))
		return dest, os.Rename(path, dest)
	}, nil)
	return trash
}

func saveIdea(t *testing.T, store *Store, title string, updated int64) Saved {
	t.Helper()
	saved, err := store.Create(title, updated)
	if err != nil {
		t.Fatal(err)
	}
	applied, err := Apply(EmptyGraph(), block(centre(IdOf(title), title)), 1, updated)
	if err != nil {
		t.Fatal(err)
	}
	saved.Graph = applied.Graph
	saved.Turns = []Turn{{Turn: 1, At: updated, Role: RoleYou, Text: "About " + title}}
	saved.Info.Updated = updated
	if err := store.Save(saved); err != nil {
		t.Fatal(err)
	}
	return saved
}

func TestListShowsEveryFolderTheOneChangedLastFirst(t *testing.T) {
	t.Parallel()
	store, root := makeTestStore(t)
	saveIdea(t, store, "Forge notes", 1000)
	saveIdea(t, store, "A family budget", 3000)
	saveIdea(t, store, "A safe video app for children", 2000)
	// Not brainstorms: a file, a folder without brainstorm.json, a hidden folder.
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"empty", ".hidden"} {
		if err := os.Mkdir(filepath.Join(root, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	list, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	var titles []string
	for _, entry := range list {
		titles = append(titles, entry.Title)
		if entry.State != StateOpen || entry.Id == "" || entry.Dir != filepath.Join(root, entry.Slug) {
			t.Errorf("entry %+v", entry)
		}
	}
	if strings.Join(titles, "|") != "A family budget|A safe video app for children|Forge notes" {
		t.Errorf("titles %v", titles)
	}
	if got := store.Titles(2); strings.Join(got, "|") != "A family budget|A safe video app for children" {
		t.Errorf("the brief's titles %v", got)
	}
}

// Review of #2248: two long titles that share their first 48 letters get two folders, "<slug>" and "<slug>-2", and each
// keeps its own name: a forget of one never takes the other.
func TestLongTitlesKeepTheirOwnFolder(t *testing.T) {
	t.Parallel()
	store, root := makeTestStore(t)
	testTrash(t, store)
	prefix := "Controle parental tres complet et tres configurable"
	games := saveIdea(t, store, prefix+" pour les jeux", 2000)
	videos := saveIdea(t, store, prefix+" pour les videos", 3000)
	if games.Info.Slug == videos.Info.Slug || filepath.Base(videos.Dir) != videos.Info.Slug {
		t.Fatalf("slugs %q and %q, folder %q", games.Info.Slug, videos.Info.Slug, filepath.Base(videos.Dir))
	}
	list, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Slug != videos.Info.Slug || list[1].Slug != games.Info.Slug {
		t.Fatalf("list %+v", list)
	}
	loaded, err := store.LoadSlug(videos.Info.Slug)
	if err != nil || loaded.Info.Id != videos.Info.Id || loaded.Info.Slug != videos.Info.Slug {
		t.Fatalf("load: %+v %v", loaded.Info, err)
	}
	// The id must be the folder's: a forget naming the other's id takes nothing.
	if _, err := store.Delete(videos.Info.Slug, games.Info.Id, false); !errors.Is(err, ErrUnknownBrainstorm) {
		t.Fatalf("a forget with another brainstorm's id: %v", err)
	}
	if _, err := store.Delete(videos.Info.Slug, videos.Info.Id, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(games.Dir); err != nil {
		t.Errorf("forgetting the videos took the games: %v", err)
	}
	if entries, _ := os.ReadDir(root); len(entries) != 1 {
		t.Errorf("%d folders left", len(entries))
	}
}

func TestNearTitles(t *testing.T) {
	t.Parallel()
	near := [][2]string{
		{"A safe video app for children", "a safe video app for children!"},
		{"A safe video app for children", "A safe video app for childrens"},
		{"Forge notes", "forge-notes"},
		{"Forge notes 2", "Forge notes"},
		{"日本語", "日本語"},
	}
	for _, pair := range near {
		if !NearTitle(pair[0], pair[1]) {
			t.Errorf("%q and %q are not near", pair[0], pair[1])
		}
	}
	far := [][2]string{
		{"A safe video app for children", "A family budget"},
		{"Notes", "Nodes"},
		{"日本語", "中文"},
	}
	for _, pair := range far {
		if NearTitle(pair[0], pair[1]) {
			t.Errorf("%q and %q are near", pair[0], pair[1])
		}
	}
}

// AC10a: /brainstorm with an idea that is already saved asks first.
func TestFindTheSameOrANearlyTheSameTitle(t *testing.T) {
	t.Parallel()
	store, _ := makeTestStore(t)
	kids := saveIdea(t, store, "A safe video app for children", 2000)
	saveIdea(t, store, "A family budget", 3000)
	match, ok, err := store.Find("a safe video app for children")
	if err != nil || !ok || match.Slug != kids.Info.Slug {
		t.Fatalf("find: %+v %v %v", match, ok, err)
	}
	if _, ok, _ := store.Find("A garden planner"); ok {
		t.Error("another idea found a match")
	}
	if _, ok, _ := store.Find("   "); ok {
		t.Error("an empty title found a match")
	}
}

// AC-4: a rename keeps the slug unique, moves the folder, and the title stays the developer's.
func TestRenameMovesTheFolderToAFreeSlug(t *testing.T) {
	t.Parallel()
	store, root := makeTestStore(t)
	kids := saveIdea(t, store, "A safe video app for children", 2000)
	saveIdea(t, store, "Kids videos", 1000)
	if err := store.Remember(kids.Dir); err != nil {
		t.Fatal(err)
	}
	renamed, err := store.Rename(kids.Info.Slug, "Kids videos", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Info.Slug != "kids-videos-2" || renamed.Dir != filepath.Join(root, "kids-videos-2") {
		t.Fatalf("renamed to %s at %s", renamed.Info.Slug, renamed.Dir)
	}
	if _, err := os.Stat(kids.Dir); !os.IsNotExist(err) {
		t.Errorf("the old folder is still there: %v", err)
	}
	back, err := store.LoadSlug("kids-videos-2")
	if err != nil {
		t.Fatal(err)
	}
	if back.Info.Title != "Kids videos" || !back.Info.Named || back.Info.Id != kids.Info.Id || len(back.Turns) != 1 {
		t.Errorf("after the rename: %+v", back.Info)
	}
	if other, err := store.LoadSlug("kids-videos"); err != nil || other.Info.Id == kids.Info.Id {
		t.Errorf("the other folder of that title was touched: %+v %v", other.Info, err)
	}
	if cur, ok, _ := store.Current(); !ok || cur.Dir != renamed.Dir {
		t.Errorf("current.json did not follow the move: %+v", cur.Dir)
	}
	// The same slug again: the folder stays where it is.
	again, err := store.Rename("kids-videos-2", "Kids Videos", 6000)
	if err != nil || again.Dir != renamed.Dir {
		t.Errorf("a rename to the same slug moved it: %s %v", again.Dir, err)
	}
	if _, err := store.Rename("kids-videos-2", "   ", 7000); err == nil {
		t.Error("an empty title was taken")
	}
}

// AC-4 and the security rationale: only a slug MoltenTerm makes, of a folder right under the brainstorms folder,
// reaches a path.
func TestOnlyABrainstormsSlugReachesAPath(t *testing.T) {
	t.Parallel()
	store, root := makeTestStore(t)
	testTrash(t, store)
	saveIdea(t, store, "Forge notes", 1000)
	outside := filepath.Join(filepath.Dir(root), "outside")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, InfoFile), []byte(`{"title":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	for _, slug := range []string{"../outside", "..", ".", "", "/etc", "Forge-Notes", "forge notes", "linked", "missing", strings.Repeat("a", 60)} {
		if _, err := store.LoadSlug(slug); !errors.Is(err, ErrUnknownBrainstorm) {
			t.Errorf("load %q: %v", slug, err)
		}
		if _, err := store.Delete(slug, "", false); !errors.Is(err, ErrUnknownBrainstorm) {
			t.Errorf("delete %q: %v", slug, err)
		}
		if _, err := store.Rename(slug, "New title", 1); !errors.Is(err, ErrUnknownBrainstorm) {
			t.Errorf("rename %q: %v", slug, err)
		}
	}
	if _, err := os.Stat(filepath.Join(outside, InfoFile)); err != nil {
		t.Errorf("the folder outside was touched: %v", err)
	}
}

// AC10d: a forgotten folder goes to the trash, whole; where the system has none it is removed; a move that fails keeps
// it.
func TestDeleteMovesTheFolderToTheTrash(t *testing.T) {
	t.Parallel()
	store, root := makeTestStore(t)
	trash := testTrash(t, store)
	kids := saveIdea(t, store, "A safe video app for children", 2000)
	if err := store.Remember(kids.Dir); err != nil {
		t.Fatal(err)
	}
	deleted, err := store.Delete(kids.Info.Slug, kids.Info.Id, false)
	if err != nil || !deleted.Trashed || deleted.Summary.Id != kids.Info.Id {
		t.Fatalf("delete: %+v %v", deleted, err)
	}
	if _, err := os.Stat(kids.Dir); !os.IsNotExist(err) {
		t.Errorf("the folder is still there")
	}
	if _, err := os.Stat(filepath.Join(trash, kids.Info.Slug, GraphFile)); err != nil {
		t.Errorf("the trash does not hold the folder whole: %v", err)
	}
	if _, ok, _ := store.Current(); ok {
		t.Error("current.json still names the forgotten brainstorm")
	}
	if list, _ := store.List(); len(list) != 0 {
		t.Errorf("list %+v", list)
	}

	// No trash on this system: the folder goes for good only when the confirmation said so (review of #2248).
	budget := saveIdea(t, store, "A family budget", 3000)
	store.UseTrash(func(string) (string, error) { return "", errTestNoTrash }, func() bool { return false })
	if store.CanTrash() {
		t.Fatal("a system without a trash says it has one")
	}
	if _, err := store.Delete(budget.Info.Slug, budget.Info.Id, false); !errors.Is(err, ErrNeedsRemoveConfirmation) {
		t.Fatalf("a removal the confirmation did not say: %v", err)
	}
	if _, err := os.Stat(budget.Dir); err != nil {
		t.Fatalf("the folder went without its confirmation: %v", err)
	}
	if deleted, err := store.Delete(budget.Info.Slug, budget.Info.Id, true); err != nil || deleted.Trashed {
		t.Fatalf("a delete without a trash: %+v %v", deleted, err)
	}
	if _, err := os.Stat(budget.Dir); !os.IsNotExist(err) {
		t.Errorf("a folder without a trash is still there")
	}

	// A move to the trash that fails is never followed by a removal, whatever the confirmation said.
	notes := saveIdea(t, store, "Forge notes", 4000)
	store.UseTrash(func(string) (string, error) { return "", errors.New("another volume") }, nil)
	for _, permanent := range []bool{false, true} {
		if _, err := store.Delete(notes.Info.Slug, notes.Info.Id, permanent); err == nil {
			t.Fatal("a failed move was taken as a delete")
		}
	}
	if _, err := store.LoadSlug(notes.Info.Slug); err != nil {
		t.Errorf("a failed move lost the folder: %v", err)
	}
	if entries, _ := os.ReadDir(root); len(entries) != 1 {
		t.Errorf("the brainstorms folder holds %d entries", len(entries))
	}
}

// Review of #2248: a rename that fails once the folder moved puts it back where it was, current.json with it.
func TestAFailedRenameMovesTheFolderBack(t *testing.T) {
	t.Parallel()
	store, root := makeTestStore(t)
	kids := saveIdea(t, store, "A safe video app for children", 2000)
	if err := store.Remember(kids.Dir); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(store.stateDir, currentFile))
	if err != nil {
		t.Fatal(err)
	}
	// A state folder that takes no new file: current.json cannot follow the move, after the folder moved.
	if err := os.Chmod(store.stateDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(store.stateDir, 0o700) })
	got, err := store.Rename(kids.Info.Slug, "Kids videos", 5000)
	if err == nil {
		t.Fatal("a rename whose current.json could not follow was taken")
	}
	if got.Dir != kids.Dir || got.Info.Slug != kids.Info.Slug {
		t.Errorf("after the failed rename the brainstorm is named %q at %q", got.Info.Slug, got.Dir)
	}
	if _, err := os.Stat(filepath.Join(kids.Dir, InfoFile)); err != nil {
		t.Errorf("the folder is not back where it was: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "kids-videos")); !os.IsNotExist(err) {
		t.Errorf("the moved folder is still there: %v", err)
	}
	if current, _ := os.ReadFile(filepath.Join(store.stateDir, currentFile)); string(current) != string(data) {
		t.Errorf("current.json changed: %s", current)
	}
}

func TestTheResumeBriefSaysWhereItStoodAndGoesWithItsBrainstorm(t *testing.T) {
	t.Parallel()
	store, _ := makeTestStore(t)
	brokk := filepath.Join(t.TempDir(), BrokkFolderName)
	kids := saveIdea(t, store, "A safe video app for children", 2000)
	applied, err := Apply(kids.Graph, block(add("ages", KindQuestion, "For which ages?", kids.Graph.Centre), add("three-ten", KindAnswer, "From 3 to 10", "ages")), 2, 2100)
	if err != nil {
		t.Fatal(err)
	}
	kids.Graph = applied.Graph
	kids.Turns = append(kids.Turns, Turn{Turn: 1, At: 2000, Role: RoleBrokk, Text: "For which ages?\x1b[2J"})
	if err := WriteResume(brokk, kids); err != nil {
		t.Fatal(err)
	}
	text := readText(t, filepath.Join(brokk, ResumeFile))
	for _, want := range []string{"# Brainstorm resumed: A safe video app for children", "`" + kids.Graph.Centre + "` topic", "  - `ages` question: For which ages?", "    - `three-ten` answer: From 3 to 10", "- You: For which ages?"} {
		if !strings.Contains(text, want) {
			t.Errorf("the resume brief lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "\x1b") {
		t.Error("a control character reached his folder")
	}
	// Another brainstorm's forget leaves it; its own takes it away.
	if err := ClearResume(brokk, "someone-else"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(brokk, ResumeFile)); err != nil {
		t.Fatal("another brainstorm's forget removed the resume brief")
	}
	if err := ClearResume(brokk, kids.Info.Id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(brokk, ResumeFile)); !os.IsNotExist(err) {
		t.Error("the forgotten brainstorm's resume brief is still in his folder")
	}
}

func TestAForkKeepsAReferenceInEachGraph(t *testing.T) {
	t.Parallel()
	g, err := CentredGraph("Parental control for games", 10)
	if err != nil {
		t.Fatal(err)
	}
	if g.Centre != "parental-control-for-games" || len(g.Nodes) != 1 || g.Nodes[0].Kind != KindTopic {
		t.Fatalf("centred graph %+v", g)
	}
	withRef := WithReference(g, "A safe video app for children", "abc123", 20)
	if len(withRef.Nodes) != 2 || withRef.Nodes[1].Kind != KindReference || withRef.Nodes[1].From != g.Centre || withRef.Nodes[1].Ref != "abc123" {
		t.Fatalf("reference %+v", withRef.Nodes)
	}
	if again := WithReference(withRef, "A safe video app for children", "abc123", 30); len(again.Nodes) != 2 {
		t.Error("the same reference was added twice")
	}
	if _, err := ValidateGraph(withRef); err != nil {
		t.Errorf("a graph with a reference does not load back: %v", err)
	}
	bad := withRef
	bad.Nodes = append([]Node{}, withRef.Nodes...)
	bad.Nodes[1].Ref = "../x"
	if _, err := ValidateGraph(bad); err == nil {
		t.Error("a reference that is not an id was taken")
	}
	// Brokk never adds a reference himself.
	if _, err := Apply(g, block(add("r", KindReference, "x", g.Centre)), 2, 1); err == nil {
		t.Error("an add of a reference node was taken")
	}
}

func TestForkResumeAndForgetAreCheckedAndNeverChangeTheGraph(t *testing.T) {
	t.Parallel()
	g := sampleGraph(t)
	ops := block(
		Op{Op: OpFork, Title: "Parental control for games", Reason: "another product"},
		Op{Op: OpResume, Title: "Forge notes"},
		Op{Op: OpForget, Title: "A family budget"},
	)
	applied, err := Apply(g, ops, 9, 9)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.Graph.Nodes) != len(g.Nodes) || applied.Skipped != 3 {
		t.Errorf("the questions changed the graph: %d nodes, %d skipped", len(applied.Graph.Nodes), applied.Skipped)
	}
	for _, op := range []Op{{Op: OpFork}, {Op: OpResume, Title: strings.Repeat("x", MaxText+1)}, {Op: OpForget, Title: "x", Reason: strings.Repeat("y", MaxText+1)}} {
		if err := ValidateBlock(block(op)); err == nil {
			t.Errorf("%+v was taken", op)
		}
	}
}
