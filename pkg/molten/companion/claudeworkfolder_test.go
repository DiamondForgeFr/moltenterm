// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// siblingTreeFixture (#2522): a project's main checkout on develop, a linked worktree of it beside the project folder
// (../Project-1320, outside .claude/worktrees) on the ticket's branch, and another repository. The git folders are
// written as git writes them: no git command runs.
type siblingTreeFixture struct {
	main    string
	sibling string
	other   string
}

func makeSiblingTreeFixture(t *testing.T) siblingTreeFixture {
	t.Helper()
	base := t.TempDir()
	f := siblingTreeFixture{
		main:    filepath.Join(base, "Project"),
		sibling: filepath.Join(base, "Project-1320"),
		other:   filepath.Join(base, "Elsewhere"),
	}
	writeFile(t, filepath.Join(f.main, ".git", "HEAD"), "ref: refs/heads/develop\n")
	linked := filepath.Join(f.main, ".git", "worktrees", "Project-1320")
	writeFile(t, filepath.Join(linked, "HEAD"), "ref: refs/heads/feature/1320-meeting-images\n")
	writeFile(t, filepath.Join(linked, "commondir"), "../..\n")
	writeFile(t, filepath.Join(f.sibling, ".git"), "gitdir: "+linked+"\n")
	writeFile(t, filepath.Join(f.sibling, "src", "app.ts"), "")
	writeFile(t, filepath.Join(f.other, ".git", "HEAD"), "ref: refs/heads/feature/77-elsewhere\n")
	return f
}

// claudeToolLine is an assistant record of a sub-agent working from its lead's folder (cwd) through one tool call.
func claudeToolLine(t *testing.T, cwd string, tool string, input map[string]string) string {
	t.Helper()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf(`{"type":"assistant","cwd":%q,"message":{"model":"claude-opus-5-5","content":[{"type":"tool_use","name":%q,"input":%s}]}}`, cwd, tool, data)
}

func TestClaudeSubagentInSiblingWorktree(t *testing.T) {
	f := makeSiblingTreeFixture(t)
	root := t.TempDir()
	project := filepath.Join(root, ClaudeSlug(f.main))
	subs := filepath.Join(project, claudeIdentitySession, "subagents")
	session := filepath.Join(project, claudeIdentitySession+".jsonl")
	if err := os.MkdirAll(subs, 0o700); err != nil {
		t.Fatal(err)
	}
	writeLines(t, session, fmt.Sprintf(`{"type":"user","cwd":%q,"message":{"role":"user","content":"go"}}`, f.main))
	write := func(id string, lines ...string) {
		writeLines(t, filepath.Join(subs, "agent-"+id+".meta.json"), fmt.Sprintf(`{"agentType":"sf-fix","description":"Build #1320 meeting images","toolUseId":"toolu_%s"}`, id))
		writeLines(t, filepath.Join(subs, "agent-"+id+".jsonl"), lines...)
	}
	// The Notulia sub-agent of #2522: every record names the lead's checkout, its commands drive the sibling worktree.
	write("a1",
		claudeToolLine(t, f.main, "Bash", map[string]string{"command": "git -C " + f.sibling + " status -sb"}),
		claudeToolLine(t, f.main, "Read", map[string]string{"file_path": filepath.Join(f.other, "README.md")}),
		claudeToolLine(t, f.main, "Bash", map[string]string{"command": f.sibling + "/.claude/skills/sf-workflow/workflow-cli.sh status 1320"}),
	)
	// An edit is work too, wherever the file lies in the worktree.
	write("a2", claudeToolLine(t, f.main, "Edit", map[string]string{"file_path": filepath.Join(f.sibling, "src", "app.ts")}))
	// A read or a search in another worktree is no move: a reviewer only looks there.
	write("a3",
		claudeToolLine(t, f.main, "Read", map[string]string{"file_path": filepath.Join(f.sibling, "src", "app.ts")}),
		claudeToolLine(t, f.main, "Grep", map[string]string{"path": f.sibling}),
	)
	// Another repository's folder never counts.
	write("a4", claudeToolLine(t, f.main, "Bash", map[string]string{"command": "cd " + f.other + " && git status"}))

	a := MakeClaudeAdapter([]string{root})
	ids := identitiesById(ApplyHookSubagents(a.ListSubagents(session), nil, time.Now()))
	want := map[string]string{"a1": f.sibling, "a2": f.sibling, "a3": f.main, "a4": f.main}
	for id, tree := range want {
		if got := ids[id].Worktree; got != tree {
			t.Errorf("ListSubagents %s: worktree %q, want %q", id, got, tree)
		}
		facts, _ := a.ReadSubagent(session, id)
		if facts.Worktree != tree {
			t.Errorf("ReadSubagent %s: worktree %q, want %q", id, facts.Worktree, tree)
		}
	}
	facts, ok := a.ReadSubagent(session, "a1")
	if !ok || facts.Branch != "feature/1320-meeting-images" {
		t.Errorf("the sibling worktree's branch is the sub-agent's: %+v", facts)
	}
	if facts, _ := a.ReadSubagent(session, "a3"); facts.Branch != "develop" {
		t.Errorf("a reader stays on its lead's branch: %+v", facts)
	}
}

func TestCommandFolders(t *testing.T) {
	cases := map[string][]string{
		"git -C /p/tree status":                       {"/p/tree"},
		`git -C "/p/tree" log && /p/tree/bin/run x`:   {"/p/tree", "/p/tree/bin/run"},
		"cd /p/tree; npm test":                        {"/p/tree"},
		"ls /p/tree":                                  nil,
		"cat /p/tree/file | grep x":                   nil,
		"npx vitest run /p/tree/frontend/app.test.ts": nil,
	}
	for command, want := range cases {
		got := commandFolders(command)
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("commandFolders(%q) = %v, want %v", command, got, want)
		}
	}
}
