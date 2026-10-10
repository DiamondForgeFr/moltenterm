// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func currentShellEnv(f *fakeTerm) Env {
	env := f.env()
	// A current shell: Update terminal would leave it, a restart does not need it outdated.
	env.LoadJob = func(ctx context.Context, blockId string) (*waveobj.Block, *waveobj.Job, error) {
		return &waveobj.Block{OID: "b1", JobId: "job1", Meta: waveobj.MetaMapType{}}, makeJob("99", 0, 0), nil
	}
	return env
}

func TestRestartResumesTheSessionOfACurrentShell(t *testing.T) {
	f := agentTerm()
	f.session = companion.ResumeSession{Path: "/h/.claude/projects/-work/" + sessionId + ".jsonl", LinkedBy: companion.LinkHook, Sure: true}
	out := MakeUpdater(currentShellEnv(f)).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1", Agent: "claude"})
	want := "claude --resume " + sessionId
	if out.Status != StatusRestarted || out.Command != want || out.Guessed {
		t.Fatalf("restart: %+v", out)
	}
	if strings.Join(f.input, "|") != "\x1b|\x15|/exit|\r|"+want+"\r" {
		t.Errorf("typed %q", f.input)
	}
	if len(f.replaced) != 1 || f.replaced[0] != "/work/agent" {
		t.Errorf("replaced in %v, want the agent's folder", f.replaced)
	}
}

func TestRestartPassesThePermissionMode(t *testing.T) {
	f := agentTerm()
	f.session = companion.ResumeSession{Path: "/h/.claude/projects/-work/" + sessionId + ".jsonl", LinkedBy: companion.LinkHook, Sure: true}
	out := MakeUpdater(currentShellEnv(f)).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1", Mode: ModeBypassPermissions})
	want := "claude --resume " + sessionId + " --permission-mode bypassPermissions"
	if out.Status != StatusRestarted || out.Command != want {
		t.Fatalf("restart: %+v", out)
	}
	if f.input[len(f.input)-1] != want+"\r" {
		t.Errorf("typed %q", f.input)
	}
}

func TestRestartRefusesAModeItCannotPass(t *testing.T) {
	for _, tc := range []struct {
		name  string
		term  *fakeTerm
		mode  string
		agent string
	}{
		{"unknown mode", agentTerm(), "yolo", "claude"},
		{"auto is not passed", agentTerm(), ModeAuto, "claude"},
		{"codex", codexTerm(), ModeBypassPermissions, "codex"},
	} {
		out := MakeUpdater(currentShellEnv(tc.term)).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1", Mode: tc.mode})
		if out.Status != StatusUnavailable || out.Agent != tc.agent || len(tc.term.input) != 0 || len(tc.term.replaced) != 0 {
			t.Errorf("%s: %+v typed %q", tc.name, out, tc.term.input)
		}
	}
}

func codexTerm() *fakeTerm {
	return &fakeTerm{
		procs:  []proctree.Proc{shellAt(false), {Pid: 200, Ppid: 100, Pgid: 200, Tpgid: 200, Name: "codex", StartMs: 4000}},
		run:    molten.AgentRunInfo{BlockId: "b1", Agent: "codex", Running: true, State: molten.AgentStateIdle},
		exitOn: "\x1b\x15/exit\r",
	}
}

func TestRestartCodexWithoutAMode(t *testing.T) {
	f := codexTerm()
	out := MakeUpdater(currentShellEnv(f)).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1", Agent: "codex"})
	if out.Status != StatusRestarted || out.Command != "codex resume --last" || !out.Guessed {
		t.Fatalf("restart: %+v typed %q", out, f.input)
	}
}

// A busy agent is never typed into: skipped, said so.
func TestRestartSkipsABusyAgent(t *testing.T) {
	for _, state := range []string{molten.AgentStateWorking, molten.AgentStateWaiting} {
		f := agentTerm()
		f.run.State = state
		out := MakeUpdater(currentShellEnv(f)).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1"})
		if out.Status != StatusAgentBusy || len(f.input) != 0 || len(f.replaced) != 0 {
			t.Errorf("%s: %+v typed %q", state, out, f.input)
		}
	}
}

func TestRestartWithoutAnAgent(t *testing.T) {
	f := &fakeTerm{procs: []proctree.Proc{shellAt(true)}}
	out := MakeUpdater(currentShellEnv(f)).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1", Agent: "claude"})
	if out.Status != StatusNoAgent || !strings.Contains(out.Message, "Claude Code no longer runs") || len(f.input) != 0 {
		t.Fatalf("no agent: %+v", out)
	}
	f = &fakeTerm{procs: []proctree.Proc{shellAt(false), {Pid: 200, Ppid: 100, Pgid: 200, Tpgid: 200, Name: "vim"}}}
	out = MakeUpdater(currentShellEnv(f)).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1", Agent: "claude"})
	if out.Status != StatusBusy || out.Program != "vim" || len(f.input) != 0 {
		t.Fatalf("other program: %+v", out)
	}
}

func TestRestartSeesAnotherAgent(t *testing.T) {
	f := codexTerm()
	out := MakeUpdater(currentShellEnv(f)).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1", Agent: "claude"})
	if out.Status != StatusBusy || out.Program != "Codex" || len(f.input) != 0 {
		t.Fatalf("another agent: %+v", out)
	}
}

// A pane not opened since MoltenTerm started has no controller to type into: said so, nothing replaced.
func TestRestartWhenTheTerminalTakesNoInput(t *testing.T) {
	f := agentTerm()
	env := currentShellEnv(f)
	env.SendInput = func(blockId string, data []byte) error {
		return fmt.Errorf("no controller found for block %s", blockId)
	}
	out := MakeUpdater(env).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1"})
	if out.Status != StatusFailed || !strings.Contains(out.Message, "could not type in this terminal") || len(f.replaced) != 0 {
		t.Fatalf("no input: %+v replaced %v", out, f.replaced)
	}
}

func TestRestartOfARemoteTerminal(t *testing.T) {
	f := agentTerm()
	env := f.env()
	env.LoadJob = func(ctx context.Context, blockId string) (*waveobj.Block, *waveobj.Job, error) {
		job := makeJob("", 0, 0)
		job.Connection = "user@host"
		return &waveobj.Block{OID: "b1", JobId: "job1", Meta: waveobj.MetaMapType{}}, job, nil
	}
	out := MakeUpdater(env).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1"})
	if out.Status != StatusUnavailable || !strings.Contains(out.Message, "local terminal can be restarted") {
		t.Fatalf("remote: %+v", out)
	}
}
