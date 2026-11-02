// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

type subagentEnv struct {
	*fakeEnv
	subs map[string][]companion.SubagentIdentity
}

func (e *subagentEnv) Subagents(blockId string) []companion.SubagentIdentity {
	return e.subs[blockId]
}

func mkdirs(t *testing.T, dirs ...string) {
	t.Helper()
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
}

func running(kind string, model string, effort string, worktree string) companion.SubagentIdentity {
	return companion.SubagentIdentity{AgentId: "a" + kind, Kind: kind, Model: model, Effort: effort, Worktree: worktree, State: companion.SubagentRunning}
}

func TestCallerOf(t *testing.T) {
	proj := t.TempDir()
	wtBuild := filepath.Join(proj, ".claude", "worktrees", "agent-build")
	wtEdit := filepath.Join(proj, ".claude", "worktrees", "agent-edit")
	mkdirs(t, filepath.Join(wtBuild, "pkg"), wtEdit)
	build := running("sf-build", "claude-sonnet-5-5", "xhigh", wtBuild)
	edit := running("sf-edit", "claude-haiku-5-5", "high", wtEdit)
	sharing := running("sf-light", "claude-haiku-5-5", "medium", proj)
	done := build
	done.State = companion.SubagentDone
	quiet := build
	quiet.State = companion.SubagentQuiet

	cases := []struct {
		name   string
		folder string
		subs   []companion.SubagentIdentity
		want   *CallerEntry
	}{
		{"no sub-agent: the session's call", proj, nil, nil},
		{"no folder sent", "", []companion.SubagentIdentity{build}, nil},
		{"a relative folder is no folder", "pkg", []companion.SubagentIdentity{build}, nil},
		{"the sub-agent's own worktree", wtBuild, []companion.SubagentIdentity{build, edit}, &CallerEntry{Subagent: true, Kind: "sf-build", Model: "claude-sonnet-5-5", Effort: "xhigh"}},
		{"a folder inside the worktree", filepath.Join(wtBuild, "pkg"), []companion.SubagentIdentity{edit, build}, &CallerEntry{Subagent: true, Kind: "sf-build", Model: "claude-sonnet-5-5", Effort: "xhigh"}},
		{"a sibling worktree's prefix is not the worktree", wtBuild + "-x", []companion.SubagentIdentity{build}, nil},
		{"the session's folder, sub-agents in worktrees", proj, []companion.SubagentIdentity{build, edit}, nil},
		{"a finished sub-agent no longer calls", wtBuild, []companion.SubagentIdentity{done}, nil},
		{"a quiet sub-agent wrote nothing for long: not the caller", wtBuild, []companion.SubagentIdentity{quiet}, nil},
		{"a sub-agent shares the session's folder", proj, []companion.SubagentIdentity{build, sharing}, &CallerEntry{Shared: true, Kind: "sf-light", Model: "claude-haiku-5-5", Effort: "medium"}},
		{"a sub-agent whose folder is unknown", proj, []companion.SubagentIdentity{running("worker", "", "", "")}, &CallerEntry{Shared: true, Kind: "worker"}},
		{"two sub-agents in one worktree differ: only what they share", wtBuild, []companion.SubagentIdentity{build, running("sf-build", "claude-opus-5-5[1m]", "xhigh", wtBuild)}, &CallerEntry{Subagent: true, Kind: "sf-build", Effort: "xhigh"}},
		{"the same model with a context suffix is alike", wtBuild, []companion.SubagentIdentity{build, running("sf-fix", "Claude-Sonnet-5-5[1m]", "medium", wtBuild)}, &CallerEntry{Subagent: true, Model: "claude-sonnet-5-5"}},
	}
	for _, c := range cases {
		got := callerOf(c.folder, proj, c.subs)
		switch {
		case c.want == nil && got != nil:
			t.Errorf("%s: want the session's call, got %+v", c.name, *got)
		case c.want != nil && (got == nil || *got != *c.want):
			t.Errorf("%s: want %+v, got %+v", c.name, *c.want, got)
		}
	}
	if got := callerOf(wtBuild, "", []companion.SubagentIdentity{build}); got == nil || !got.Shared || got.Subagent {
		t.Fatalf("without the session's folder no worktree is known to be the sub-agent's own: %+v", got)
	}
}

// The sub-agent's model comes from its own files: Claude Code's meta file (its worktree) and transcript (its model and
// effort), read by the companion's adapter.
func TestCallerOfFromClaudeSubagentFiles(t *testing.T) {
	root := t.TempDir()
	proj := filepath.Join(root, "proj")
	wt := filepath.Join(proj, ".claude", "worktrees", "agent-abc")
	session := filepath.Join(root, "claude", "projects", "-proj", "sess-1.jsonl")
	subs := filepath.Join(strings.TrimSuffix(session, ".jsonl"), "subagents")
	mkdirs(t, wt, subs)
	files := map[string]string{
		session: `{"cwd":"` + proj + `","message":{"model":"claude-opus-5-5"}}` + "\n",
		filepath.Join(subs, "agent-abc.meta.json"): `{"agentType":"sf-build","worktreePath":"` + wt + `","description":"Fix #1756"}`,
		filepath.Join(subs, "agent-abc.jsonl"): `{"cwd":"` + wt + `","effort":"xhigh","message":{"model":"claude-sonnet-5-5"}}` + "\n" +
			`{"cwd":"` + wt + `","effort":"xhigh","message":{"model":"<synthetic>"}}` + "\n",
	}
	for path, text := range files {
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ids := companion.ApplyHookSubagents(companion.MakeClaudeAdapter([]string{filepath.Join(root, "claude")}).ListSubagents(session), nil, time.Now())
	got := callerOf(wt, proj, ids)
	if got == nil || *got != (CallerEntry{Subagent: true, Kind: "sf-build", Model: "claude-sonnet-5-5", Effort: "xhigh"}) {
		t.Fatalf("caller from the files: %+v (ids %+v)", got, ids)
	}
	if got := callerOf(proj, proj, ids); got != nil {
		t.Fatalf("the lead's folder: %+v", got)
	}
}

func TestListNamesTheCallingSubagent(t *testing.T) {
	m, env, projA, _ := makeFixture(t)
	wt := filepath.Join(projA, ".claude", "worktrees", "agent-1")
	mkdirs(t, wt)
	senv := &subagentEnv{fakeEnv: env, subs: map[string][]companion.SubagentIdentity{"blockA": {running("sf-build", "claude-sonnet-5-5", "xhigh", wt)}}}
	m.env = senv

	list, err := m.List(context.Background(), ListRequest{Token: "tokA", Folder: wt})
	if err != nil {
		t.Fatal(err)
	}
	if list.You == nil || list.You.FirstName != "Camille" || list.You.Model != "claude-opus-5-5" {
		t.Fatalf("the session stays You, with its own model: %+v", list.You)
	}
	if list.Caller == nil || !list.Caller.Subagent || list.Caller.Model != "claude-sonnet-5-5" {
		t.Fatalf("caller: %+v", list.Caller)
	}

	list, _ = m.List(context.Background(), ListRequest{Token: "tokA", Folder: projA})
	if list.Caller != nil {
		t.Fatalf("the session's folder is the session's call: %+v", list.Caller)
	}
	list, _ = m.List(context.Background(), ListRequest{Token: "tokA"})
	if list.Caller != nil {
		t.Fatalf("list_agents sends no folder: %+v", list.Caller)
	}
	m.env = env
	list, _ = m.List(context.Background(), ListRequest{Token: "tokA", Folder: wt})
	if list.Caller != nil {
		t.Fatalf("an env without sub-agents tells no call apart: %+v", list.Caller)
	}
}
