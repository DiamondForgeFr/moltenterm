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

func TestTypeShareLineBeforeStart(t *testing.T) {
	setRunningUpdater(nil)
	if out := TypeShareLine(context.Background(), "b1", "x"); out.Result != InputRefused || out.Reason != InputReasonUnavailable {
		t.Fatalf("got %+v", out)
	}
}
