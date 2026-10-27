// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reopen

import (
	"context"
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func tabEntry(ws string, id string, at int64, leaves ...Leaf) Entry {
	return Entry{
		Id:     id,
		At:     at,
		Target: Target{Kind: KindTab, WorkspaceId: ws, Name: id},
		Tab:    &Tab{Name: id, Leaves: leaves},
	}
}

// FR-SHELL-088: pane closes never push a closed view out of the library, and views have their own bound.
func TestPushKeepsViewsApartFromPanes(t *testing.T) {
	s := MakeStacks()
	s.Push(tabEntry("w", "view", 1))
	for i := 0; i < StackSize*3; i++ {
		s.Push(entry("w", fmt.Sprintf("p%d", i)))
	}
	if got := s.PutAway(); len(got) != 1 || got[0].Id != "view" {
		t.Fatalf("the view stays: %+v", got)
	}
	if s.Len("w") != StackSize+1 {
		t.Fatalf("panes keep %d, got %d entries", StackSize, s.Len("w"))
	}
	for i := 0; i < PutAwaySize+5; i++ {
		s.Push(tabEntry("w", fmt.Sprintf("v%d", i), int64(10+i)))
	}
	got := s.PutAway()
	if len(got) != PutAwaySize || got[0].Id != fmt.Sprintf("v%d", PutAwaySize+4) {
		t.Fatalf("views keep the last %d, newest first: %d %+v", PutAwaySize, len(got), got[0])
	}
	if s.Len("w") != StackSize+PutAwaySize {
		t.Fatalf("the panes stay: %d", s.Len("w"))
	}
}

func TestPutAwayListsEveryWorkspaceNewestFirst(t *testing.T) {
	s := MakeStacks()
	agent := ResumeAgent{Agent: "claude", Name: "Olivia", Command: "claude --resume abc"}
	term := Leaf{Meta: waveobj.MetaMapType{"view": "term", "cmd:cwd": "/p", "cmd:env": map[string]any{"SECRET": "x"},
		ResumeAgentMetaKey: ResumeAgentMeta(agent)}, Target: -1}
	s.Push(tabEntry("w1", "old", 100, term))
	s.Push(tabEntry("w2", "new", 200, Leaf{Meta: waveobj.MetaMapType{"view": "preview", "file": "/p/a.md"}, Target: -1}))
	s.Push(entry("w1", "pane"))
	got := s.PutAway()
	if len(got) != 2 || got[0].Id != "new" || got[1].Id != "old" || got[0].WorkspaceId != "w2" {
		t.Fatalf("views of every workspace, newest first: %+v", got)
	}
	old := got[1]
	if len(old.Panels) != 1 || old.Panels[0]["cmd:cwd"] != "/p" || old.Panels[0]["cmd:env"] != nil {
		t.Fatalf("only the keys that name a panel are listed: %+v", old.Panels)
	}
	if len(old.Agents) != 1 || old.Agents[0] != agent {
		t.Fatalf("the view's agent is listed: %+v", old.Agents)
	}
}

func TestReopenIdTakesThatView(t *testing.T) {
	var restored []string
	fail := false
	store, stacks := fakeStore(&restored, &fail), MakeStacks()
	stacks.Push(tabEntry("w", "a", 1))
	stacks.Push(tabEntry("w", "b", 2))
	ctx := context.Background()
	res, err := ReopenId(ctx, store, stacks, ReopenIdRequest{WorkspaceId: "w", Id: "a"})
	if err != nil || !res.Reopened || res.Name != "a" || res.Kind != KindTab {
		t.Fatalf("reopen a: %+v %v", res, err)
	}
	if got := stacks.PutAway(); len(got) != 1 || got[0].Id != "b" {
		t.Fatalf("a left the list: %+v", got)
	}
	if res, err := ReopenId(ctx, store, stacks, ReopenIdRequest{WorkspaceId: "w", Id: "a"}); err != nil || res.Reopened {
		t.Fatalf("a view already reopened is gone: %+v %v", res, err)
	}
	fail = true
	if _, err := ReopenId(ctx, store, stacks, ReopenIdRequest{WorkspaceId: "w", Id: "b"}); err == nil {
		t.Fatal("the restore error is reported")
	}
	if got := stacks.PutAway(); len(got) != 1 || got[0].Id != "b" {
		t.Fatalf("a failed reopen keeps the view: %+v", got)
	}
}

func TestResumeAgentMetaRoundTrip(t *testing.T) {
	a := ResumeAgent{Agent: "codex", Command: "codex resume last", Guessed: true}
	got, ok := ReadResumeAgent(waveobj.MetaMapType{ResumeAgentMetaKey: ResumeAgentMeta(a)})
	if !ok || got != a {
		t.Fatalf("round trip: %+v %v", got, ok)
	}
	if _, ok := ReadResumeAgent(waveobj.MetaMapType{ResumeAgentMetaKey: map[string]any{"agent": "x"}}); ok {
		t.Fatal("an agent without a command is not resumed")
	}
	if _, ok := AgentOf("b1"); ok {
		t.Fatal("no agent reader installed")
	}
}
