// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package materials

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// makeRepo makes a folder a repository, as far as the registry reads one (a .git entry).
func (h *harness) makeRepo(dir string) {
	h.t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		h.t.Fatal(err)
	}
}

func sessionLines(session string, cwd string, url string, path string, title string, artifact string) []string {
	return []string{
		`{"type":"user","sessionId":"` + session + `","cwd":"` + cwd + `","timestamp":"2026-10-30T10:00:00.000Z","message":{"role":"user","content":"Publish the proposal"}}`,
		`{"type":"user","sessionId":"` + session + `","cwd":"` + cwd + `","timestamp":"2026-10-30T10:01:00.000Z","message":{"role":"user","content":[{"tool_use_id":"toolu_P","type":"tool_result","content":"Published"}]},"toolUseResult":{"url":"` + url + `","path":"` + path + `","artifact_id":"` + artifact + `","title":"` + title + `","updated":false,"seq":1}}`,
	}
}

// A parent folder that is not a repository (~/Projects) is a project of its own: the sessions of the repositories under
// it are theirs, however their folders are named, and a repository's own search still finds its worktrees' sessions,
// removed ones included (#1816).
func TestRecoverKeepsSessionsOfTheirProject(t *testing.T) {
	h := makeHarness(t)
	parent := h.project
	appA := filepath.Join(parent, "apps", "a")
	appB := filepath.Join(parent, "apps", "b")
	plain := filepath.Join(parent, "scratch")
	for _, dir := range []string{appA, appB, plain} {
		os.MkdirAll(dir, 0o755)
	}
	h.makeRepo(appA)
	h.makeRepo(appB)
	roots := h.pastRoots()

	h.write("p/parent.html", "<html>parent</html>")
	h.write("p/a.html", "<html>a</html>")
	h.write("p/b.html", "<html>b</html>")
	h.write("p/plain.html", "<html>plain</html>")
	h.write("p/worktree.html", "<html>worktree</html>")
	h.writePastLines(filepath.Join(roots.claude, companion.ClaudeSlug(parent), "s-parent.jsonl"),
		sessionLines("s-parent", parent, "https://claude.ai/artifact/ParentOwn", "{{DIR}}/p/parent.html", "Parent", "aa-parent")...)
	h.writePastLines(filepath.Join(roots.claude, companion.ClaudeSlug(appA), "s-a.jsonl"),
		sessionLines("s-a", appA, "https://claude.ai/artifact/AppA", "{{DIR}}/p/a.html", "App A", "aa-a")...)
	h.writePastLines(filepath.Join(roots.claude, companion.ClaudeSlug(appB), "s-b.jsonl"),
		sessionLines("s-b", appB, "https://claude.ai/artifact/AppB", "{{DIR}}/p/b.html", "App B", "aa-b")...)
	h.writePastLines(filepath.Join(roots.claude, companion.ClaudeSlug(plain), "s-plain.jsonl"),
		sessionLines("s-plain", plain, "https://claude.ai/artifact/Plain", "{{DIR}}/p/plain.html", "Plain", "aa-plain")...)
	removed := filepath.Join(appA, ".claude", "worktrees", "agent-1")
	h.writePastLines(filepath.Join(roots.claude, companion.ClaudeSlug(removed), "s-wt.jsonl"),
		sessionLines("s-wt", removed, "https://claude.ai/artifact/AppAWorktree", "{{DIR}}/p/worktree.html", "Worktree", "aa-wt")...)

	parentKey, parentFolder := ProjectKey(parent)
	out := h.r.recover(parentKey, parentFolder, h.adapters())
	if out.Sessions != 1 || out.Found != 1 {
		t.Fatalf("the parent folder's search: %+v", out)
	}
	list, _ := h.r.store.List(parentKey)
	if len(list) != 1 || list[0].Link != "https://claude.ai/artifact/ParentOwn" {
		t.Fatalf("the parent project holds only what started in its own folder: %+v", list)
	}

	keyA, folderA := ProjectKey(appA)
	out = h.r.recover(keyA, folderA, h.adapters())
	if out.Sessions != 2 || out.Found != 2 {
		t.Fatalf("the repository's search: %+v", out)
	}
	listA, _ := h.r.store.List(keyA)
	if byLink(listA, "https://claude.ai/artifact/AppA") == nil || byLink(listA, "https://claude.ai/artifact/AppAWorktree") == nil {
		t.Fatalf("the repository holds its own and its removed worktree's: %+v", listA)
	}
	if byLink(listA, "https://claude.ai/artifact/AppB") != nil || byLink(listA, "https://claude.ai/artifact/Plain") != nil {
		t.Errorf("another project's session was read: %+v", listA)
	}
}

// A session that started in a subfolder of a repository, or in a worktree that still exists, is the repository's.
func TestRecoverSubfolderAndWorktreeOfARepository(t *testing.T) {
	h := makeHarness(t)
	h.makeRepo(h.project)
	sub := filepath.Join(h.project, "frontend")
	os.MkdirAll(sub, 0o755)
	h.write("p/sub.html", "<html>sub</html>")
	h.writePastLines(filepath.Join(h.pastRoots().claude, companion.ClaudeSlug(sub), "s-sub.jsonl"),
		sessionLines("s-sub", sub, "https://claude.ai/artifact/SubFolder", "{{DIR}}/p/sub.html", "Sub", "aa-sub")...)
	out := h.recoverNow()
	if out.Sessions != 1 || byLink(h.list(), "https://claude.ai/artifact/SubFolder") == nil {
		t.Fatalf("report %+v, list %+v", out, h.list())
	}
}

type attributionFixture struct {
	h        *harness
	parent   string
	appA     string
	appB     string
	parentK  string
	keyA     string
	keyB     string
	liveA    molten.Material
	roots    pastRoots
	scratchA string
}

// The state the search left before #1816: every session found under the parent folder filed in the parent's drawer.
func makeMisfiled(t *testing.T) *attributionFixture {
	h := makeHarness(t)
	f := &attributionFixture{h: h, parent: h.project, roots: h.pastRoots()}
	f.appA = filepath.Join(f.parent, "apps", "a")
	f.appB = filepath.Join(f.parent, "apps", "b")
	os.MkdirAll(f.appA, 0o755)
	os.MkdirAll(f.appB, 0o755)
	h.makeRepo(f.appA)
	h.makeRepo(f.appB)
	var parentFolder string
	f.parentK, parentFolder = ProjectKey(f.parent)
	var folderA string
	f.keyA, folderA = ProjectKey(f.appA)
	f.keyB, _ = ProjectKey(f.appB)

	file := func(rel string) string { return h.write("m/"+rel, "<html>"+rel+"</html>") }
	put := func(c Capture) molten.Material {
		c.Project, c.Folder, c.Source, c.Tool = f.parentK, parentFolder, molten.MaterialSourcePublished, molten.AgentIdClaude
		m, _, err := h.r.capture(c)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	// A live capture of the repository's own drawer, which makes the drawer known.
	live, _, err := h.r.capture(Capture{Project: f.keyA, Folder: folderA, Source: molten.MaterialSourcePublished, Path: file("live.html"), Link: "https://claude.ai/artifact/LiveA", ArtifactId: "aa-live-a", WorkspaceId: "ws-a", Agent: "Adrien", Tool: molten.AgentIdClaude, SessionId: "s-live"})
	if err != nil {
		t.Fatal(err)
	}
	f.liveA = live
	// Live in the parent project: the workspace's project stands, whatever the folder its agent works in.
	put(Capture{Path: file("live-parent.html"), Link: "https://claude.ai/artifact/LiveParent", ArtifactId: "aa-live-parent", WorkspaceId: "ws-parent", Agent: "Diane", SessionId: "s-live-parent"})

	f.scratchA = filepath.Join("/private/tmp/claude-501", companion.ClaudeSlug(f.appA), "s-gone-a", "scratchpad", "report.html")
	cases := []struct {
		session string
		cwd     string
		link    string
		artif   string
		path    string
	}{
		{"s-parent", f.parent, "https://claude.ai/artifact/OwnParent", "aa-own", file("own.html")},
		{"s-a", f.appA, "https://claude.ai/artifact/OnlyA", "aa-only-a", file("only-a.html")},
		{"s-b", f.appB, "https://claude.ai/artifact/OnlyB", "aa-only-b", file("only-b.html")},
		{"s-dup", f.appA, "https://claude.ai/artifact/LiveA", "aa-live-a", file("dup.html")},
		{"s-lost", filepath.Join(os.TempDir(), "gone-folder-1816", "x"), "https://claude.ai/artifact/Lost", "aa-lost", file("lost.html")},
	}
	for _, c := range cases {
		put(Capture{Path: c.path, Link: c.link, ArtifactId: c.artif, SessionId: c.session})
		h.writePastLines(filepath.Join(f.roots.claude, companion.ClaudeSlug(c.cwd), c.session+".jsonl"),
			sessionLines(c.session, c.cwd, c.link, c.path, "T", c.artif)...)
	}
	// No transcript left: the scratch folder of the agent says where the session started, or nothing does.
	put(Capture{Path: f.scratchA, Link: "https://claude.ai/artifact/ScratchA", ArtifactId: "aa-scratch-a", SessionId: "s-gone-a"})
	put(Capture{Link: "https://claude.ai/artifact/NoWhere", ArtifactId: "aa-nowhere", SessionId: "s-gone-b"})
	return f
}

// TestAttributeRecovered (#1816): the materials the search filed under a parent folder go back to the project their
// session started in; a duplicate of a live capture is not kept twice; one whose project cannot be told goes to No
// project; a live capture stays; the pass runs once.
func TestAttributeRecovered(t *testing.T) {
	f := makeMisfiled(t)
	h := f.h
	before, _ := h.r.store.List(f.parentK)
	if len(before) != 8 {
		t.Fatalf("fixture: %d materials in the parent's drawer", len(before))
	}
	ownCopy := byLink(before, "https://claude.ai/artifact/OnlyA")
	if ownCopy == nil || ownCopy.CopyPath == "" {
		t.Fatalf("fixture: %+v", ownCopy)
	}

	moved, complete := h.r.attribute(h.adapters())
	if !complete || moved != 6 {
		t.Fatalf("moved %d, complete %v", moved, complete)
	}
	parent, _ := h.r.store.List(f.parentK)
	if len(parent) != 2 || byLink(parent, "https://claude.ai/artifact/OwnParent") == nil || byLink(parent, "https://claude.ai/artifact/LiveParent") == nil {
		t.Errorf("the parent keeps its own and its live capture: %+v", parent)
	}
	a, _ := h.r.store.List(f.keyA)
	onlyA := byLink(a, "https://claude.ai/artifact/OnlyA")
	if onlyA == nil || onlyA.Project != f.keyA || onlyA.Copy != molten.MaterialCopyKept {
		t.Fatalf("a repository's material is back in it: %+v", onlyA)
	}
	if data, err := os.ReadFile(onlyA.CopyPath); err != nil || string(data) != "<html>only-a.html</html>" {
		t.Errorf("its copy moved with it: %v %q", err, data)
	}
	if byLink(a, "https://claude.ai/artifact/ScratchA") == nil {
		t.Errorf("a material whose transcript is gone is placed by its scratch folder: %+v", a)
	}
	if n := countLink(a, "https://claude.ai/artifact/LiveA"); n != 1 {
		t.Errorf("the duplicate of a live capture is kept once: %d", n)
	}
	if live := byLink(a, "https://claude.ai/artifact/LiveA"); live == nil || live.Id != f.liveA.Id || live.WorkspaceId != "ws-a" {
		t.Errorf("the live capture stays: %+v", live)
	}
	if _, err := os.Stat(filepath.Join(h.r.store.drawerDir(f.parentK), itemsDir, ownCopy.Id)); err == nil {
		t.Errorf("the item folder was left behind")
	}
	b, _ := h.r.store.List(f.keyB)
	if byLink(b, "https://claude.ai/artifact/OnlyB") == nil {
		t.Errorf("a repository without a drawer gets one: %+v", b)
	}
	none, _ := h.r.store.List(molten.MaterialsNoProject)
	if len(none) != 2 || byLink(none, "https://claude.ai/artifact/Lost") == nil || byLink(none, "https://claude.ai/artifact/NoWhere") == nil {
		t.Errorf("what cannot be placed goes to No project: %+v", none)
	}
	if proj, _ := h.r.store.Project(f.keyB); proj.Folder != f.appB || proj.Name != "b" {
		t.Errorf("the new drawer names its project: %+v", proj)
	}

	again, complete := h.r.attribute(h.adapters())
	if !complete || again != 0 {
		t.Errorf("a second pass moves nothing: %d", again)
	}
}

func TestAttributeRecoveredRunsOnce(t *testing.T) {
	f := makeMisfiled(t)
	h := f.h
	orig := pastAgents
	pastAgents = h.adapters
	t.Cleanup(func() { pastAgents = orig })
	h.r.AttributeRecovered()
	if _, err := os.Stat(filepath.Join(h.r.store.Root(), attributedMarker)); err != nil {
		t.Fatalf("the pass leaves its mark: %v", err)
	}
	list, _ := h.r.store.List(f.keyA)
	before := len(list)
	h.write("m/after.html", "<html>after</html>")
	if _, _, err := h.r.capture(Capture{Project: f.parentK, Source: molten.MaterialSourcePublished, Path: filepath.Join(h.dir, "m", "after.html"), Link: "https://claude.ai/artifact/After", SessionId: "s-a"}); err != nil {
		t.Fatal(err)
	}
	h.r.AttributeRecovered()
	if after, _ := h.r.store.List(f.keyA); len(after) != before {
		t.Errorf("a marked pass does not run again")
	}
	if parent, _ := h.r.store.List(f.parentK); byLink(parent, "https://claude.ai/artifact/After") == nil {
		t.Errorf("a marked pass touched the parent's drawer")
	}
}

// A cut between the target's index and the source's leaves the material in both: the next pass finishes the move.
func TestMoveFinishesACutMove(t *testing.T) {
	f := makeMisfiled(t)
	h := f.h
	list, _ := h.r.store.List(f.parentK)
	m := byLink(list, "https://claude.ai/artifact/OnlyA")
	// The target's index names the material; its folder has not moved.
	h.r.store.lock.Lock()
	dst, _ := h.r.store.loadLocked(f.keyA)
	moved := *m
	moved.Project = f.keyA
	dst.index.Materials = append(dst.index.Materials, moved)
	h.r.store.saveLocked(dst, "")
	h.r.store.lock.Unlock()

	if ok, err := h.r.store.moveMaterial(f.parentK, m.Id, f.keyA, ""); err != nil || !ok {
		t.Fatalf("move: %v %v", ok, err)
	}
	a, _ := h.r.store.List(f.keyA)
	got := byLink(a, "https://claude.ai/artifact/OnlyA")
	if got == nil || countLink(a, "https://claude.ai/artifact/OnlyA") != 1 {
		t.Fatalf("one material: %+v", a)
	}
	if _, err := os.Stat(got.CopyPath); err != nil {
		t.Errorf("its copy is in the target: %v", err)
	}
	if parent, _ := h.r.store.List(f.parentK); byLink(parent, "https://claude.ai/artifact/OnlyA") != nil {
		t.Errorf("the source forgot it")
	}
}

func countLink(list []molten.Material, link string) int {
	n := 0
	for _, m := range list {
		if m.Link == link {
			n++
		}
	}
	return n
}
