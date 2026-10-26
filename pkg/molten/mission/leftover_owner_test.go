// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import "testing"

// fakeProcs: parents gives each pid its parent.
type fakeProcs struct {
	parents map[int32]int32
	names   map[int32]string
	cwds    map[int32]string
}

func (f fakeProcs) Under(pid int32, root int32) bool {
	for i := 0; i < 10; i++ {
		if pid == root {
			return true
		}
		next, ok := f.parents[pid]
		if !ok {
			return false
		}
		pid = next
	}
	return false
}

func (f fakeProcs) Name(pid int32) string { return f.names[pid] }

func (f fakeProcs) Cwd(pid int32) string { return f.cwds[pid] }

func TestResolveLockOwner(t *testing.T) {
	const tree = "/p/.claude/worktrees/agent-a44"
	places := []AgentPlace{
		{BlockId: "review", Agent: "claude", FirstName: "Rita", Pid: 44215, Review: true},
		{BlockId: "b-valentin", Agent: "claude", FirstName: "Valentin", Pid: 44215, Cwd: "/p"},
		{BlockId: "b-camille", Agent: "codex", FirstName: "Camille", Pid: 5000, Cwd: tree + "/sub"},
	}
	procs := fakeProcs{
		parents: map[int32]int32{44300: 44215, 7000: 1},
		names:   map[int32]string{7000: "node"},
		cwds:    map[int32]string{7000: "/elsewhere"},
	}

	// The holder is the agent's own process, or one of its children; a review session's terminal never owns it.
	for _, pid := range []int32{44215, 44300} {
		got := ResolveLockOwner(LockHolder{Pid: pid}, tree, places, nil, procs)
		if got.Via != OwnerViaAgent || got.BlockId != "b-valentin" || got.FirstName != "Valentin" || !got.Reachable() {
			t.Fatalf("pid %d: a named agent: %+v", pid, got)
		}
	}

	// A sub-agent's worktree: Claude Code locks it with the parent session's pid, which owns it.
	subs := []BranchAgent{{Worktree: tree, Kind: UpcomingAgentSubagent, ParentBlockId: "b-valentin", ParentFirstName: "Valentin"}}
	got := ResolveLockOwner(LockHolder{Pid: 44215}, tree, places, subs, procs)
	if got.Via != OwnerViaParent || got.BlockId != "b-valentin" {
		t.Fatalf("a sub-agent's worktree names its parent session: %+v", got)
	}
	// The same without the process table: the sub-agent still names its parent.
	got = ResolveLockOwner(LockHolder{Pid: 99}, tree, places, subs, nil)
	if got.Via != OwnerViaParent || got.BlockId != "b-valentin" {
		t.Fatalf("a sub-agent's parent without the process table: %+v", got)
	}

	// No process match: an agent terminal working in the worktree.
	got = ResolveLockOwner(LockHolder{Pid: 99}, tree, places, nil, procs)
	if got.Via != OwnerViaTerminal || got.BlockId != "b-camille" || got.FirstName != "Camille" {
		t.Fatalf("an agent terminal in the worktree: %+v", got)
	}

	// An unknown process: its name and folder, and nobody to ask.
	got = ResolveLockOwner(LockHolder{Pid: 7000}, tree, places[:2], nil, procs)
	if got.Via != OwnerViaProcess || got.Process != "node" || got.Folder != "/elsewhere" || got.Pid != 7000 || got.Reachable() {
		t.Fatalf("an unknown process: %+v", got)
	}
}

func TestWithinFolder(t *testing.T) {
	if !within("/a/b", "/a/b") || !within("/a/b/c", "/a/b") || within("/a/bc", "/a/b") || within("/a", "/a/b") || within("", "/a") {
		t.Fatalf("within")
	}
}
