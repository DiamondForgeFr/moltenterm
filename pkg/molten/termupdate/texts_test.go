// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The windows word each outcome by its code (#656); the English stays as it was, for agents and logs.

func checkText(t *testing.T, name string, got *uimsg.Text, code string, vars map[string]string) {
	t.Helper()
	if got == nil || got.Code != code {
		t.Errorf("%s: text %+v, want code %s", name, got, code)
		return
	}
	for k, v := range vars {
		if got.Vars[k] != v {
			t.Errorf("%s: var %s = %q, want %q (%+v)", name, k, got.Vars[k], v, got.Vars)
		}
	}
}

func TestAgentInputCodes(t *testing.T) {
	f := claudeInputTerm()
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionClear})
	checkText(t, "sent", out.MessageText, "termupdate.input.sent", map[string]string{"agent": "Claude Code", "text": "/clear"})
	if out.Message != "Sent /clear to Claude Code." {
		t.Errorf("sent: English %q", out.Message)
	}

	f = claudeInputTerm()
	f.run.State = molten.AgentStateWorking
	out = ask(f, AgentInputRequest{Action: agentcontinuity.ActionInterrupt})
	checkText(t, "interrupt", out.MessageText, "termupdate.input.sentinterrupt", map[string]string{"agent": "Claude Code"})

	f = claudeInputTerm()
	f.procs = []proctree.Proc{shellAt(false), {Pid: 200, Ppid: 100, Pgid: 200, Name: "claude", StartMs: 4000}, {Pid: 300, Ppid: 200, Pgid: 300, Tpgid: 300, Name: "vim", StartMs: 5000}}
	f.procs[0].Tpgid = 300
	out = ask(f, AgentInputRequest{Action: agentcontinuity.ActionClear})
	checkText(t, "vim", out.MessageText, "termupdate.input.notforeground", map[string]string{"program": "vim", "agent": "Claude Code"})
	if out.Message != "vim is in the foreground of this terminal, not Claude Code: nothing was typed." {
		t.Errorf("vim: English %q", out.Message)
	}

	f = claudeInputTerm()
	f.procs = []proctree.Proc{shellAt(true)}
	out = ask(f, AgentInputRequest{Action: agentcontinuity.ActionClear})
	checkText(t, "no agent", out.MessageText, "termupdate.input.noagent", map[string]string{"agent": "Claude Code"})

	// #1024: a terminal whose shell ended, or that was closed, has no agent any more.
	f = claudeInputTerm()
	f.procs = nil
	out = ask(f, AgentInputRequest{Action: agentcontinuity.ActionClear})
	checkText(t, "shell ended", out.MessageText, "termupdate.input.terminalgone", nil)
	if out.Reason != InputReasonTerminalGone || strings.Contains(out.Message, "b1") {
		t.Errorf("shell ended: %+v", out)
	}
	f = claudeInputTerm()
	f.closed = true
	out = ask(f, AgentInputRequest{Action: agentcontinuity.ActionClear})
	checkText(t, "closed", out.MessageText, "termupdate.input.terminalgone", nil)

	f = claudeInputTerm()
	out = ask(f, AgentInputRequest{Action: agentcontinuity.ActionPermissionMode, Mode: "nope"})
	checkText(t, "unknown mode", out.MessageText, "termupdate.input.unknownmode", map[string]string{"mode": "nope"})
}

func TestAgentInputModeCodes(t *testing.T) {
	f := claudeInputTerm()
	f.state.Mode = ModePlan
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionPermissionMode, Mode: ModePlan})
	checkText(t, "already", out.MessageText, "termupdate.input.alreadymode", map[string]string{"mode": ModePlan})
	if out.Message != "Claude Code is already in Plan mode." {
		t.Errorf("already: English %q", out.Message)
	}
}

func TestShareLineCodes(t *testing.T) {
	f := claudeInputTerm()
	out := typeLine(f, "look at this")
	checkText(t, "typed", out.MessageText, "termupdate.line.typed", map[string]string{"agent": "Claude Code"})
	out = typeLine(claudeInputTerm(), "")
	checkText(t, "empty", out.MessageText, "termupdate.line.none", nil)
}

func TestUpdateCodes(t *testing.T) {
	f := &fakeTerm{procs: []proctree.Proc{shellAt(false), {Pid: 200, Ppid: 100, Pgid: 200, Tpgid: 200, Name: "sleep"}}}
	out := MakeUpdater(f.env()).Run(context.Background(), Request{BlockId: "b1", Confirmed: true})
	checkText(t, "busy", out.MessageText, "termupdate.update.programbusy", map[string]string{"program": "sleep"})

	f = agentTerm()
	f.session = companion.ResumeSession{Path: "/h/.claude/projects/-work/" + sessionId + ".jsonl", LinkedBy: companion.LinkGuessed}
	out = MakeUpdater(f.env()).Run(context.Background(), Request{BlockId: "b1", Confirmed: true})
	checkText(t, "guessed", out.MessageText, "termupdate.update.doneguessed", map[string]string{"agent": "Claude Code", "command": "claude --continue"})

	f = agentTerm()
	f.run.State = molten.AgentStateWorking
	out = MakeUpdater(f.env()).Run(context.Background(), Request{BlockId: "b1", Confirmed: true})
	checkText(t, "working", out.MessageText, "termupdate.update.agentworking", map[string]string{"agent": "Claude Code"})
}

func TestRestartCodes(t *testing.T) {
	f := agentTerm()
	f.session = companion.ResumeSession{Path: "/h/.claude/projects/-work/" + sessionId + ".jsonl", LinkedBy: companion.LinkHook, Sure: true}
	out := MakeUpdater(currentShellEnv(f)).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1", Agent: "claude"})
	checkText(t, "restarted", out.MessageText, "termupdate.restart.done", map[string]string{"agent": "Claude Code", "command": "claude --resume " + sessionId})

	f = agentTerm()
	f.run.State = molten.AgentStateWaiting
	out = MakeUpdater(currentShellEnv(f)).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1"})
	checkText(t, "waiting", out.MessageText, "termupdate.restart.agentwaiting", map[string]string{"agent": "Claude Code"})

	f = agentTerm()
	env := f.env()
	env.LoadJob = func(ctx context.Context, blockId string) (*waveobj.Block, *waveobj.Job, error) {
		job := makeJob("", 0, 0)
		job.Connection = "user@host"
		return &waveobj.Block{OID: "b1", JobId: "job1", Meta: waveobj.MetaMapType{}}, job, nil
	}
	out = MakeUpdater(env).RestartAgent(context.Background(), AgentRestartRequest{BlockId: "b1"})
	checkText(t, "remote", out.MessageText, "termupdate.restart.notlocal", nil)
}
