// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestComputeWork(t *testing.T) {
	blocks := map[string]BlockInfo{
		"agent-working": {WorkspaceId: "ws-a"},
		"agent-waiting": {WorkspaceId: "ws-b"},
		"agent-done":    {WorkspaceId: "ws-c"},
		"build":         {WorkspaceId: "ws-d"},
		"ssh-local":     {WorkspaceId: "ws-e"},
		"remote-cmd":    {WorkspaceId: "ws-f", Remote: true},
		"remote-agent":  {WorkspaceId: "ws-g", Remote: true},
		"cmd-block":     {WorkspaceId: "ws-h", Cmd: "npm run dev"},
		"cmd-ssh":       {WorkspaceId: "ws-i", Cmd: "ssh build-box"},
	}
	src := WorkSources{
		Agents: func() []molten.AgentRunInfo {
			return []molten.AgentRunInfo{
				{BlockId: "agent-working", Running: true, State: molten.AgentStateWorking},
				{BlockId: "agent-waiting", Running: true, State: molten.AgentStateWaiting},
				{BlockId: "agent-done", Running: true, State: molten.AgentStateDone},
				{BlockId: "remote-agent", Running: true, State: molten.AgentStateWorking},
			}
		},
		Commands: func() map[string]string {
			return map[string]string{
				// The agent's own process is the foreground command: its state decides.
				"agent-waiting": "claude",
				"agent-done":    "codex",
				"build":         "make all",
				"ssh-local":     "TERM=xterm ssh dev@host",
				"remote-cmd":    "make all",
			}
		},
		CommandBlocks: func() []string { return []string{"cmd-block", "cmd-ssh"} },
		Locate: func(ctx context.Context, blockId string) (BlockInfo, bool) {
			info, ok := blocks[blockId]
			return info, ok
		},
		MissionWorkspaces: func(ctx context.Context) []string { return []string{"ws-m"} },
	}
	work := ComputeWork(context.Background(), src)
	want := map[string]bool{"ws-a": true, "ws-d": true, "ws-g": true, "ws-h": true, "ws-m": true}
	if !reflect.DeepEqual(work.Workspaces, want) || !work.Local {
		t.Fatalf("work %+v, want %v", work, want)
	}
}

func TestComputeWorkLocalOnlyCountsLocalSessions(t *testing.T) {
	src := WorkSources{
		Agents: func() []molten.AgentRunInfo {
			return []molten.AgentRunInfo{{BlockId: "remote-agent", Running: true, State: molten.AgentStateWorking}}
		},
		Locate: func(ctx context.Context, blockId string) (BlockInfo, bool) {
			return BlockInfo{WorkspaceId: "ws-g", Remote: true}, true
		},
	}
	work := ComputeWork(context.Background(), src)
	if work.Local || !work.Workspaces["ws-g"] {
		t.Fatalf("work %+v", work)
	}
}

func TestIsSshCommand(t *testing.T) {
	cases := map[string]bool{
		"ssh host":                true,
		"/usr/bin/ssh -A host":    true,
		"mosh host":               true,
		"FOO=1 ssh host":          true,
		"sudo ssh root@host":      true,
		"sshfs host:/ /mnt":       false,
		"git push":                false,
		"":                        false,
		"echo ssh":                false,
		"autossh -M 0 tunnel-box": true,
	}
	for in, want := range cases {
		if got := IsSshCommand(in); got != want {
			t.Errorf("IsSshCommand(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestCommandTracker(t *testing.T) {
	tr := makeCommandTracker()
	tr.observe("b1", markCommand, "make")
	tr.observe("b2", markCommand, "")
	tr.observe("b2", markPrompt, "")
	if got := tr.snapshot(); !reflect.DeepEqual(got, map[string]string{"b1": "make"}) {
		t.Fatalf("snapshot %v", got)
	}
	tr.observe("b1", markDone, "")
	if len(tr.snapshot()) != 0 {
		t.Fatalf("command still running after its end")
	}
	tr.observe("b3", markCommand, "vim")
	tr.forget("b3")
	if len(tr.snapshot()) != 0 {
		t.Fatalf("closed block kept")
	}
}

func TestParseCaffeinate(t *testing.T) {
	cases := []struct {
		args []string
		want CaffeinateCall
	}{
		{[]string{"-i", "-t", "300"}, CaffeinateCall{Timeout: 300 * time.Second}},
		{[]string{"-dit300"}, CaffeinateCall{Timeout: 300 * time.Second}},
		{[]string{"-w", "42"}, CaffeinateCall{WaitPid: 42}},
		{[]string{"-i", "sleep", "600"}, CaffeinateCall{Command: []string{"sleep", "600"}}},
		{[]string{"-s", "--", "-weird"}, CaffeinateCall{Command: []string{"-weird"}}},
		{[]string{"make", "-j8"}, CaffeinateCall{Command: []string{"make", "-j8"}}},
		{[]string{}, CaffeinateCall{}},
		{[]string{"-x"}, CaffeinateCall{Invalid: true}},
		{[]string{"-t"}, CaffeinateCall{Invalid: true}},
		{[]string{"-t", "soon"}, CaffeinateCall{Invalid: true}},
	}
	for _, c := range cases {
		if got := ParseCaffeinate(c.args); !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseCaffeinate(%v) = %+v, want %+v", c.args, got, c.want)
		}
	}
}

func TestParseInhibit(t *testing.T) {
	cases := []struct {
		args []string
		want InhibitCall
	}{
		{[]string{"--what=sleep", "--why", "build", "make"}, InhibitCall{Command: []string{"make"}}},
		{[]string{"--who=me", "--", "sleep", "5"}, InhibitCall{Command: []string{"sleep", "5"}}},
		{[]string{"--list"}, InhibitCall{Passthrough: true}},
		{[]string{"--what=idle"}, InhibitCall{Passthrough: true}},
		{[]string{"-h"}, InhibitCall{Passthrough: true}},
		{[]string{"--no-pager", "cat"}, InhibitCall{Command: []string{"cat"}}},
	}
	for _, c := range cases {
		if got := ParseInhibit(c.args); !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseInhibit(%v) = %+v, want %+v", c.args, got, c.want)
		}
	}
}
