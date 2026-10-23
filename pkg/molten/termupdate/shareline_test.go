// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

func typeLine(f *inputTerm, line string) AgentInputResult {
	return MakeUpdater(f.env()).TypeLine(context.Background(), "b1", line)
}

func TestTypeLinePastesWithoutEnter(t *testing.T) {
	f := claudeInputTerm()
	f.state.Draft = true
	out := typeLine(f, "I shared the tab \"Docs\" (https://example.com/a) with you.")
	if out.Result != InputSent || out.AgentName != "Claude Code" {
		t.Fatalf("got %+v", out)
	}
	want := "\x1b[200~I shared the tab \"Docs\" (https://example.com/a) with you.\x1b[201~"
	if strings.Join(f.input, "|") != want {
		t.Fatalf("typed %q", f.input)
	}
	for _, step := range f.input {
		if strings.ContainsAny(step, "\r\n") {
			t.Fatalf("nothing may submit the line: %q", step)
		}
	}
}

func TestTypeLineStripsControlCharacters(t *testing.T) {
	f := claudeInputTerm()
	out := typeLine(f, "a\rb\n\x1b[201~c\x03")
	if out.Result != InputSent || strings.Join(f.input, "|") != "\x1b[200~ab[201~c\x1b[201~" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

func TestTypeLineRefusals(t *testing.T) {
	for _, tc := range []struct {
		name   string
		setup  func(f *inputTerm)
		line   string
		reason string
	}{
		{"working", func(f *inputTerm) { f.run.State = molten.AgentStateWorking }, "x", InputReasonWorking},
		{"waiting for an answer", func(f *inputTerm) { f.run.State = molten.AgentStateWaiting }, "x", InputReasonWaiting},
		{"vim in the foreground", func(f *inputTerm) {
			f.procs = []proctree.Proc{shellAt(false), {Pid: 200, Ppid: 100, Pgid: 200, Name: "claude", StartMs: 4000}, {Pid: 300, Ppid: 200, Pgid: 300, Tpgid: 300, Name: "vim", StartMs: 5000}}
			f.procs[0].Tpgid = 300
		}, "x", InputReasonNotForeground},
		{"shell at its prompt", func(f *inputTerm) { f.procs = []proctree.Proc{shellAt(true)} }, "x", InputReasonNoAgent},
		{"empty line", func(f *inputTerm) {}, "\r\n", InputReasonUnknownAction},
		{"too long", func(f *inputTerm) {}, strings.Repeat("x", maxTypedLine+1), InputReasonUnknownAction},
	} {
		f := claudeInputTerm()
		tc.setup(f)
		out := typeLine(f, tc.line)
		if out.Result != InputRefused || out.Reason != tc.reason || out.Message == "" {
			t.Errorf("%s: %+v", tc.name, out)
		}
		if len(f.input) != 0 {
			t.Errorf("%s: typed %q", tc.name, f.input)
		}
	}
}

func TestHandoffLineSubmitsWithoutADraft(t *testing.T) {
	f := claudeInputTerm()
	f.state.Draft = false
	out := MakeUpdater(f.env()).typeLine(context.Background(), "b1", "[From Camille] do it", true)
	if out.Result != InputSent || !out.Submitted || strings.Join(f.input, "|") != "\x1b[200~[From Camille] do it\x1b[201~|\r" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
	g := claudeInputTerm()
	g.state.Draft = true
	out = MakeUpdater(g.env()).typeLine(context.Background(), "b1", "[From Camille] do it", true)
	if out.Result != InputSent || out.Submitted || strings.Join(g.input, "|") != "\x1b[200~[From Camille] do it\x1b[201~" {
		t.Fatalf("a draft must not be sent: %+v, typed %q", out, g.input)
	}
}

func TestTypeShareLineBeforeStart(t *testing.T) {
	setRunningUpdater(nil)
	if out := TypeShareLine(context.Background(), "b1", "x"); out.Result != InputRefused || out.Reason != InputReasonUnavailable {
		t.Fatalf("got %+v", out)
	}
}

// #1024: every typing path checks the terminal is live first. A terminal of a tab not loaded since a restart gets its
// controller and takes the line; a gone one types nothing, ends the agent's run record and says so in plain words.
func TestHandoffLineChecksTheTerminalIsLive(t *testing.T) {
	f := claudeInputTerm()
	out := MakeUpdater(f.env()).typeLine(context.Background(), "b1", "do it", true)
	if out.Result != InputSent || f.attached != 1 || len(f.ended) != 0 {
		t.Fatalf("live: %+v, attached %d, ended %v", out, f.attached, f.ended)
	}

	f = claudeInputTerm()
	f.attachErr = ErrTerminalGone
	out = MakeUpdater(f.env()).typeLine(context.Background(), "b1", "do it", true)
	if out.Result != InputRefused || out.Reason != InputReasonTerminalGone || len(f.input) != 0 {
		t.Fatalf("gone: %+v, typed %q", out, f.input)
	}
	if strings.Join(f.ended, ",") != "b1" {
		t.Fatalf("the run of a gone terminal must end: %v", f.ended)
	}
	if out.MessageText == nil || out.MessageText.Code != "termupdate.input.terminalgone" || strings.Contains(out.Message, "b1") {
		t.Fatalf("gone: text %+v, %q", out.MessageText, out.Message)
	}

	f = claudeInputTerm()
	f.closed = true
	out = MakeUpdater(f.env()).typeLine(context.Background(), "b1", "do it", true)
	if out.Reason != InputReasonTerminalGone || strings.Join(f.ended, ",") != "b1" || f.attached != 0 {
		t.Fatalf("closed: %+v, ended %v, attached %d", out, f.ended, f.attached)
	}
}

// The liveness check may reattach a shell where the agent no longer runs: nothing is typed then.
func TestHandoffLineLooksAgainAfterAttaching(t *testing.T) {
	f := claudeInputTerm()
	env := f.env()
	attach := env.Attach
	env.Attach = func(ctx context.Context, blockId string) error {
		f.lock.Lock()
		f.procs = []proctree.Proc{shellAt(true)}
		f.lock.Unlock()
		return attach(ctx, blockId)
	}
	out := MakeUpdater(env).typeLine(context.Background(), "b1", "do it", true)
	if out.Result != InputRefused || len(f.input) != 0 {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}
