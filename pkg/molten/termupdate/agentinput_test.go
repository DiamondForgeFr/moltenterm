// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

// inputTerm is an agent terminal whose input line and permission mode the test drives. cycle: the modes Shift+Tab
// goes through; seen: the agent draws its mode after each press.
type inputTerm struct {
	*fakeTerm
	state AgentInputState
	cycle []string
	seen  bool
}

func (f *inputTerm) env() Env {
	env := f.fakeTerm.env()
	send := env.SendInput
	env.SendInput = func(blockId string, data []byte) error {
		if err := send(blockId, data); err != nil {
			return err
		}
		if string(data) == "\x1b[Z" && f.seen && len(f.cycle) > 0 {
			f.lock.Lock()
			defer f.lock.Unlock()
			at := 0
			for i, m := range f.cycle {
				if m == f.state.Mode {
					at = i
				}
			}
			f.state.Mode = f.cycle[(at+1)%len(f.cycle)]
		}
		return nil
	}
	env.InputState = func(blockId string) AgentInputState {
		f.lock.Lock()
		defer f.lock.Unlock()
		return f.state
	}
	return env
}

func claudeInputTerm() *inputTerm {
	f := agentTerm()
	f.exitOn = ""
	return &inputTerm{fakeTerm: f}
}

func ask(f *inputTerm, req AgentInputRequest) AgentInputResult {
	if req.BlockId == "" {
		req.BlockId = "b1"
	}
	if req.Agent == "" {
		req.Agent = "claude"
	}
	return MakeUpdater(f.env()).AgentInput(context.Background(), req)
}

func TestAgentInputTypesTheCommand(t *testing.T) {
	f := claudeInputTerm()
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionClear})
	if out.Result != InputSent || strings.Join(f.input, "|") != "\x15|/clear|\r" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
	if out.AgentName != "Claude Code" {
		t.Fatalf("agent name: %+v", out)
	}
}

func TestAgentInputQuitUsesTheAdapterExit(t *testing.T) {
	f := claudeInputTerm()
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionQuit})
	exit := agentcontinuity.Find("claude").Exit().Command
	if out.Result != InputSent || strings.Join(f.input, "|") != "\x15|"+exit+"|\r" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

func TestAgentInputInterruptGoesThroughWhileWorking(t *testing.T) {
	f := claudeInputTerm()
	f.run.State = molten.AgentStateWorking
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionInterrupt})
	if out.Result != InputSent || strings.Join(f.input, "|") != "\x1b" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

func TestAgentInputRefusals(t *testing.T) {
	for _, tc := range []struct {
		name   string
		setup  func(f *inputTerm)
		req    AgentInputRequest
		reason string
		offer  string
	}{
		{"working", func(f *inputTerm) { f.run.State = molten.AgentStateWorking }, AgentInputRequest{Action: agentcontinuity.ActionCompact}, InputReasonWorking, OfferInterrupt},
		{"waiting", func(f *inputTerm) { f.run.State = molten.AgentStateWaiting }, AgentInputRequest{Action: agentcontinuity.ActionStatus}, InputReasonWaiting, OfferGoto},
		{"waiting, interrupt", func(f *inputTerm) { f.run.State = molten.AgentStateWaiting }, AgentInputRequest{Action: agentcontinuity.ActionInterrupt}, InputReasonWaiting, OfferGoto},
		{"vim in the foreground", func(f *inputTerm) {
			f.procs = []proctree.Proc{shellAt(false), {Pid: 200, Ppid: 100, Pgid: 200, Name: "claude", StartMs: 4000}, {Pid: 300, Ppid: 200, Pgid: 300, Tpgid: 300, Name: "vim", StartMs: 5000}}
			f.procs[0].Tpgid = 300
		}, AgentInputRequest{Action: agentcontinuity.ActionClear}, InputReasonNotForeground, ""},
		{"sleep at the shell", func(f *inputTerm) {
			f.procs = []proctree.Proc{shellAt(false), {Pid: 200, Ppid: 100, Pgid: 200, Tpgid: 200, Name: "sleep", StartMs: 4000}}
		}, AgentInputRequest{Action: agentcontinuity.ActionClear}, InputReasonNotForeground, ""},
		{"another agent", func(f *inputTerm) {}, AgentInputRequest{Agent: "codex", Action: agentcontinuity.ActionNew}, InputReasonNotForeground, ""},
		{"shell at its prompt", func(f *inputTerm) { f.procs = []proctree.Proc{shellAt(true)} }, AgentInputRequest{Action: agentcontinuity.ActionClear}, InputReasonNoAgent, ""},
		{"not in the table", func(f *inputTerm) {}, AgentInputRequest{Action: "rm -rf /"}, InputReasonUnknownAction, ""},
		{"codex command for claude", func(f *inputTerm) {}, AgentInputRequest{Action: agentcontinuity.ActionDiff}, InputReasonUnknownAction, ""},
		{"draft", func(f *inputTerm) { f.state.Draft = true }, AgentInputRequest{Action: agentcontinuity.ActionClear}, InputReasonDraft, ""},
		{"unknown block", func(f *inputTerm) { f.procs = nil }, AgentInputRequest{BlockId: "nope", Action: agentcontinuity.ActionClear}, InputReasonUnavailable, ""},
	} {
		f := claudeInputTerm()
		tc.setup(f)
		out := ask(f, tc.req)
		if out.Result != InputRefused || out.Reason != tc.reason || out.Offer != tc.offer || out.Message == "" {
			t.Errorf("%s: %+v", tc.name, out)
		}
		if len(f.input) != 0 {
			t.Errorf("%s: typed %q", tc.name, f.input)
		}
	}
}

func TestAgentInputNamesTheForegroundProgram(t *testing.T) {
	f := claudeInputTerm()
	f.procs = []proctree.Proc{shellAt(false), {Pid: 200, Ppid: 100, Pgid: 200, Name: "claude", StartMs: 4000}, {Pid: 300, Ppid: 200, Pgid: 300, Tpgid: 300, Name: "vim", StartMs: 5000}}
	f.procs[0].Tpgid = 300
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionClear})
	if out.Program != "vim" || !strings.Contains(out.Message, "vim is in the foreground") {
		t.Fatalf("%+v", out)
	}
}

func TestAgentInputConfirmedDraftIsCleared(t *testing.T) {
	f := claudeInputTerm()
	f.state.Draft = true
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionCompact, ConfirmedDraft: true})
	if out.Result != InputSent || strings.Join(f.input, "|") != "\x15|/compact|\r" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

func TestAgentInputKeysIgnoreTheDraft(t *testing.T) {
	f := claudeInputTerm()
	f.state.Draft = true
	if out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionPermissionMode}); out.Result != InputSent || len(f.input) != 1 {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

func TestAgentInputCodexTable(t *testing.T) {
	f := claudeInputTerm()
	f.procs[1].Name = "codex"
	f.run.Agent = "codex"
	out := ask(f, AgentInputRequest{Agent: "codex", Action: agentcontinuity.ActionApprovals})
	if out.Result != InputSent || strings.Join(f.input, "|") != "\x15|/approvals|\r" || out.AgentName != "Codex" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
	f.input = nil
	if out := ask(f, AgentInputRequest{Agent: "codex", Action: agentcontinuity.ActionPermissionMode}); out.Reason != InputReasonUnknownAction || len(f.input) != 0 {
		t.Fatalf("codex has no Shift+Tab mode: %+v %q", out, f.input)
	}
}

func TestPermissionModeStepsToTheTarget(t *testing.T) {
	f := claudeInputTerm()
	f.cycle = []string{ModeDefault, ModeAcceptEdits, ModePlan}
	f.seen = true
	f.state.Mode = ModeDefault
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionPermissionMode, Mode: ModePlan})
	if out.Result != InputSent || out.Mode != ModePlan || out.Presses != 2 || len(f.input) != 2 {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
	f.input = nil
	out = ask(f, AgentInputRequest{Action: agentcontinuity.ActionPermissionMode, Mode: ModePlan})
	if out.Presses != 0 || len(f.input) != 0 {
		t.Fatalf("already there: %+v, typed %q", out, f.input)
	}
	out = ask(f, AgentInputRequest{Action: agentcontinuity.ActionPermissionMode, Mode: ModeDefault})
	if out.Mode != ModeDefault || out.Presses != 1 {
		t.Fatalf("round the cycle: %+v", out)
	}
}

func TestPermissionModeUnknownPressesOnce(t *testing.T) {
	f := claudeInputTerm()
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionPermissionMode, Mode: ModePlan})
	if out.Result != InputSent || out.Presses != 1 || len(f.input) != 1 || f.input[0] != "\x1b[Z" || out.Mode != "" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

func TestPermissionModeStopsWhenTheModeIsNotDrawn(t *testing.T) {
	f := claudeInputTerm()
	f.cycle = []string{ModeDefault, ModeAcceptEdits, ModePlan}
	f.state.Mode = ModeDefault
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionPermissionMode, Mode: ModePlan})
	if out.Presses != 1 || len(f.input) != 1 {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

func TestPermissionModeOutsideTheCycleStops(t *testing.T) {
	f := claudeInputTerm()
	f.cycle = []string{ModeDefault, ModeAcceptEdits, ModePlan}
	f.seen = true
	f.state.Mode = ModeDefault
	out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionPermissionMode, Mode: ModeBypassPermissions})
	if out.Presses != maxModePresses || !strings.Contains(out.Message, "was not reached") {
		t.Fatalf("got %+v", out)
	}
	if out := ask(f, AgentInputRequest{Action: agentcontinuity.ActionPermissionMode, Mode: "yolo"}); out.Reason != InputReasonUnknownAction {
		t.Fatalf("unknown mode: %+v", out)
	}
}

func TestStopAgentStillTypesItsExit(t *testing.T) {
	f := agentTerm()
	u := MakeUpdater(f.env())
	agent := molten.AgentProcess{Agent: "claude", Pid: 200, StartMs: 4000}
	if got := u.StopAgent("b1", agentcontinuity.Find("claude"), agent, 100); got != StopExited || strings.Join(f.input, "") != "\x1b\x15/exit\r" {
		t.Fatalf("got %q, typed %q", got, f.input)
	}
}

func TestParseClaudeMode(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want string
	}{
		{"\x1b[2K\x1b[38;5;45m⏸ plan mode on\x1b[39m (shift+tab to cycle)", ModePlan},
		{"⏵⏵ accept edits on (shift+tab to cycle)", ModeAcceptEdits},
		{"⏵⏵ bypass permissions on", ModeBypassPermissions},
		{"  ? for shortcuts", ModeDefault},
		{"⏸ plan mode on ... later frame ? for shortcuts", ModeDefault},
		{"\x1b]0;title plan mode on\x07 hello", ""},
		{"nothing here", ""},
	} {
		if got := ParseClaudeMode([]byte(tc.in)); got != tc.want {
			t.Errorf("%q: got %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestScanDraft(t *testing.T) {
	for _, tc := range []struct {
		name  string
		in    []string
		draft bool
	}{
		{"typed", []string{"hel", "lo"}, true},
		{"sent", []string{"hello", "\r"}, false},
		{"cleared", []string{"hello\x15"}, false},
		{"ctrl+c", []string{"hello", "\x03"}, false},
		{"arrows only", []string{"\x1b[A\x1b[B\x1bOA"}, false},
		{"shift+tab", []string{"\x1b[Z"}, false},
		{"paste with a newline", []string{"\x1b[200~line1\nline2\x1b[201~"}, true},
		{"alt+enter", []string{"a", "\x1b\r"}, true},
		{"sent after a paste", []string{"\x1b[200~x\x1b[201~", "\r"}, false},
	} {
		draft, paste := false, false
		for _, chunk := range tc.in {
			draft, paste = ScanDraft([]byte(chunk), draft, paste)
		}
		if draft != tc.draft {
			t.Errorf("%s: draft %v", tc.name, draft)
		}
	}
}

func TestInputWatch(t *testing.T) {
	run := molten.AgentRunInfo{BlockId: "b1", Agent: "claude", Running: true, Started: 10}
	precise := true
	w := makeInputWatch(func(string) (molten.AgentRunInfo, bool) { return run, true }, func(string) bool { return precise })
	w.input("b1", []byte("draft"))
	w.output("b1", []byte("⏸ plan mode on"))
	st := w.state("b1")
	if !st.Draft || st.Mode != ModePlan || len(st.Modes) != 1 {
		t.Fatalf("%+v", st)
	}
	w.input("b1", []byte("\r"))
	if st := w.state("b1"); st.Draft {
		t.Fatalf("sent: %+v", st)
	}
	precise = false
	if st := w.state("b1"); !st.Draft {
		t.Fatalf("an agent without hooks may always hold a draft: %+v", st)
	}
	precise = true
	run.Started = 20
	if st := w.state("b1"); st.Mode != "" || st.Draft {
		t.Fatalf("a new run knows nothing: %+v", st)
	}
	run.Agent = "codex"
	w.output("b1", []byte("plan mode on"))
	if st := w.state("b1"); st.Mode != "" {
		t.Fatalf("only Claude Code draws these modes: %+v", st)
	}
}
