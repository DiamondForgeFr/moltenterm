// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path string, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The folder a session started in is the first one its records name: an agent that moves into a worktree, or into
// another project's folder, still belongs to the project it was started in (#1816).
func TestPastSessionFolderIsTheFirstOne(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "-p", "s1.jsonl")
	writeFile(t, path, `{"type":"summary","leafUuid":"x"}`+"\n"+
		`{"type":"user","cwd":"/work/app","sessionId":"s1","message":{"role":"user","content":"hi"}}`+"\n"+
		`{"type":"user","cwd":"/work/other","sessionId":"s1","message":{"role":"user","content":"cd"}}`+"\n")
	adapter := MakeClaudeAdapter([]string{root})
	if got := PastSessionFolder(adapter, path); got != "/work/app" {
		t.Errorf("folder %q", got)
	}
	if got := PastSessionFolder(adapter, filepath.Join(root, "missing.jsonl")); got != "" {
		t.Errorf("a missing transcript has no folder: %q", got)
	}
	codex := filepath.Join(root, "rollout-1.jsonl")
	writeFile(t, codex, `{"type":"session_meta","payload":{"id":"c1","cwd":"/work/codex"}}`+"\n")
	if got := PastSessionFolder(MakeCodexAdapter([]string{root}), codex); got != "/work/codex" {
		t.Errorf("codex folder %q", got)
	}
}

func TestFindPastSession(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "-p", "5e55e55e-0000-4000-8000-0000000014aa.jsonl"), "{}\n")
	adapter := MakeClaudeAdapter([]string{root})
	if got, ok := FindPastSession(adapter, "5e55e55e-0000-4000-8000-0000000014aa"); !ok || filepath.Base(got) != "5e55e55e-0000-4000-8000-0000000014aa.jsonl" {
		t.Errorf("found %q %v", got, ok)
	}
	for _, bad := range []string{"", "../x", "nope"} {
		if _, ok := FindPastSession(adapter, bad); ok {
			t.Errorf("%q found", bad)
		}
	}
}

// A project folder that is not a repository holds no project under it: only a repository holds the folders under it.
func TestSessionFolderBelongs(t *testing.T) {
	parent := t.TempDir()
	repo := filepath.Join(parent, "apps", "a")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		project string
		cwd     string
		want    bool
		why     string
	}{
		{parent, parent, true, "the folder itself"},
		{parent, repo, false, "a repository under a parent folder is its own project"},
		{parent, parent + "-old", false, "a folder whose name starts with the project's"},
		{repo, repo, true, "the repository itself"},
		{repo, filepath.Join(repo, "frontend"), true, "a subfolder"},
		{repo, filepath.Join(repo, ".claude", "worktrees", "agent-1"), true, "a worktree, removed or not"},
		{repo, repo + "-old", false, "a folder whose name starts with the repository's"},
		{repo, "", false, "no folder"},
	}
	for _, c := range cases {
		if got := SessionFolderBelongs(c.project, c.cwd); got != c.want {
			t.Errorf("%s: SessionFolderBelongs(%s, %s) = %v", c.why, c.project, c.cwd, got)
		}
	}
}

// A search reads the transcripts of the project's own folders: a parent folder's slug is a prefix of its repositories'
// slugs, which are other projects' sessions.
func TestPastSessionPathsOfAParentFolder(t *testing.T) {
	roots := t.TempDir()
	parent := t.TempDir()
	repo := filepath.Join(parent, "a")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	own := filepath.Join(roots, ClaudeSlug(parent), "own.jsonl")
	under := filepath.Join(roots, ClaudeSlug(repo), "under.jsonl")
	writeFile(t, own, "{}\n")
	writeFile(t, under, "{}\n")
	adapter := MakeClaudeAdapter([]string{roots})
	if got := PastSessionPaths(adapter, []string{parent}); len(got) != 1 || got[0] != own {
		t.Errorf("parent folder: %v", got)
	}
	if got := PastSessionPaths(adapter, []string{repo}); len(got) != 1 || got[0] != under {
		t.Errorf("repository: %v", got)
	}
}
