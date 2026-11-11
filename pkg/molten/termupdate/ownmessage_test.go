// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package termupdate

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func ownMessage(f *inputTerm, text string, facts OwnPromptFacts) AgentInputResult {
	return MakeUpdater(f.env()).typeOwnMessage(context.Background(), "b1", cleanMessage(text), facts)
}

func atRest(rest bool) func() bool {
	return func() bool { return rest }
}

// #2257: Brokk's message is submitted with Enter when his agent is at rest and his prompt is empty.
func TestOwnMessageIsSubmitted(t *testing.T) {
	f := claudeInputTerm()
	f.state = AgentInputState{Known: true, Precise: true}
	out := ownMessage(f, "an idea for an app", OwnPromptFacts{})
	if out.Result != InputSent || !out.Submitted || strings.Join(f.input, "|") != pasteStart+"an idea for an app"+pasteEnd+"|\r" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

// #2257: what MoltenTerm left in his prompt, or a prompt not followed since a restart, is emptied first, so a retry
// never stacks the message.
func TestOwnMessageClearsWhatMoltenTermLeft(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state AgentInputState
	}{
		{"its own leftover", AgentInputState{Draft: true, Own: true, Known: true, Precise: true}},
		{"a prompt not followed since a restart", AgentInputState{Known: false, Precise: true}},
	} {
		f := claudeInputTerm()
		f.state = tc.state
		out := ownMessage(f, "again", OwnPromptFacts{})
		if out.Result != InputSent || strings.Join(f.input, "|") != keyClearInput+"|"+pasteStart+"again"+pasteEnd+"|\r" {
			t.Errorf("%s: got %+v, typed %q", tc.name, out, f.input)
		}
	}
}

// #2257: a human's text in his prompt is never sent nor cleared: nothing is typed.
func TestOwnMessageLeavesAHumansTextAlone(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state AgentInputState
		facts OwnPromptFacts
	}{
		{"seen by the watch", AgentInputState{Draft: true, Foreign: true, Known: true, Precise: true}, OwnPromptFacts{}},
		{"remembered across a restart", AgentInputState{Known: false, Precise: true}, OwnPromptFacts{HumanTyped: true}},
	} {
		f := claudeInputTerm()
		f.state = tc.state
		out := ownMessage(f, "hello", tc.facts)
		if out.Result != InputRefused || out.Reason != InputReasonHumanDraft || len(f.input) != 0 {
			t.Errorf("%s: got %+v, typed %q", tc.name, out, f.input)
		}
	}
	// Once the watch saw the prompt emptied, the remembered draft is gone.
	f := claudeInputTerm()
	f.state = AgentInputState{Known: true, Precise: true}
	if out := ownMessage(f, "hello", OwnPromptFacts{HumanTyped: true}); out.Result != InputSent {
		t.Fatalf("a prompt seen emptied since: %+v", out)
	}
}

// #2257: without hooks reporting in this run, Enter waits for his transcript to show him at rest; nothing is typed
// before, so it never answers a question he asks.
func TestOwnMessageWaitsForAnAgentAtRest(t *testing.T) {
	for _, tc := range []struct {
		name  string
		facts OwnPromptFacts
		sent  bool
	}{
		{"transcript at rest", OwnPromptFacts{AtRest: atRest(true)}, true},
		{"a call pending", OwnPromptFacts{AtRest: atRest(false)}, false},
		{"no transcript", OwnPromptFacts{}, false},
	} {
		f := claudeInputTerm()
		f.state = AgentInputState{Draft: true, Known: true, Precise: false}
		out := ownMessage(f, "hello", tc.facts)
		if tc.sent && (out.Result != InputSent || !out.Submitted) {
			t.Errorf("%s: got %+v", tc.name, out)
		}
		if !tc.sent && (out.Result != InputRefused || out.Reason != InputReasonUnsettled || len(f.input) != 0) {
			t.Errorf("%s: got %+v, typed %q", tc.name, out, f.input)
		}
	}
}

func TestOwnMessageRefusals(t *testing.T) {
	for _, tc := range []struct {
		name   string
		setup  func(f *inputTerm)
		text   string
		reason string
	}{
		{"working", func(f *inputTerm) { f.run.State = molten.AgentStateWorking }, "x", InputReasonWorking},
		{"waiting for an answer", func(f *inputTerm) { f.run.State = molten.AgentStateWaiting }, "x", InputReasonWaiting},
		{"shell at its prompt", func(f *inputTerm) { f.procs = f.procs[:1]; f.procs[0] = shellAt(true) }, "x", InputReasonNoAgent},
		{"empty", func(f *inputTerm) {}, " \r\n", InputReasonUnknownAction},
		{"too long", func(f *inputTerm) {}, strings.Repeat("x", MaxOwnSessionText+1), InputReasonUnknownAction},
	} {
		f := claudeInputTerm()
		f.state = AgentInputState{Known: true, Precise: true}
		tc.setup(f)
		out := ownMessage(f, tc.text, OwnPromptFacts{AtRest: atRest(true)})
		if out.Result != InputRefused || out.Reason != tc.reason || len(f.input) != 0 {
			t.Errorf("%s: got %+v, typed %q", tc.name, out, f.input)
		}
	}
}

// #2257, end to end with the input watch: a leftover of MoltenTerm's is its own and is cleared; a human's key makes it
// theirs and nothing is typed; once they empty the prompt, the message goes without clearing anything.
func TestOwnMessageFollowsWhoseTextIsInThePrompt(t *testing.T) {
	f := claudeInputTerm()
	run := f.run
	run.Started = 1
	w := makeInputWatch(func(string) (molten.AgentRunInfo, bool) { return run, true }, func(string) bool { return true })
	var told []bool
	w.watchOwn("b1", func(foreign bool) { told = append(told, foreign) })
	env := f.env()
	send := env.SendInput
	env.SendInput = func(blockId string, data []byte) error {
		if err := send(blockId, data); err != nil {
			return err
		}
		w.input(blockId, data)
		return nil
	}
	env.InputState = w.state
	env.ExpectOwn = w.expectOwn
	u := MakeUpdater(env)
	say := func(text string) AgentInputResult {
		return u.typeOwnMessage(context.Background(), "b1", text, OwnPromptFacts{})
	}

	// A restart: the agent ran before the watch, which knows nothing of its prompt.
	if out := say("first"); out.Result != InputSent || f.input[0] != keyClearInput {
		t.Fatalf("an unknown prompt is emptied first: %+v, typed %q", out, f.input)
	}
	if st := w.state("b1"); !st.Known || st.Draft || st.Foreign {
		t.Fatalf("after a submitted message: %+v", st)
	}
	// An earlier path left MoltenTerm's line without Enter.
	f.input = nil
	takeBack := w.expectOwn("b1", []byte(pasteStart+"left"+pasteEnd))
	_ = takeBack
	w.input("b1", []byte(pasteStart+"left"+pasteEnd))
	if st := w.state("b1"); !st.Own || st.Foreign {
		t.Fatalf("MoltenTerm's leftover: %+v", st)
	}
	if out := say("second"); out.Result != InputSent || strings.Join(f.input, "|") != keyClearInput+"|"+pasteStart+"second"+pasteEnd+"|\r" {
		t.Fatalf("the leftover is emptied, not stacked: %+v, typed %q", out, f.input)
	}
	// A human types in his terminal.
	f.input = nil
	w.input("b1", []byte("my own note"))
	if out := say("third"); out.Result != InputRefused || out.Reason != InputReasonHumanDraft || len(f.input) != 0 {
		t.Fatalf("a human's text was touched: %+v, typed %q", out, f.input)
	}
	// Arrow keys and terminal answers write no text.
	w.input("b1", []byte("\x1b[A\x1b[I"))
	// They clear it themselves.
	w.input("b1", []byte("\x15"))
	if out := say("fourth"); out.Result != InputSent || strings.Join(f.input, "|") != pasteStart+"fourth"+pasteEnd+"|\r" {
		t.Fatalf("an emptied prompt: %+v, typed %q", out, f.input)
	}
	if strings.Join(boolWords(told), ",") != "true,false" {
		t.Fatalf("the owner was told %v, want the human's text coming in, then leaving", told)
	}
}

func boolWords(list []bool) []string {
	rtn := make([]string, 0, len(list))
	for _, b := range list {
		if b {
			rtn = append(rtn, "true")
		} else {
			rtn = append(rtn, "false")
		}
	}
	return rtn
}

// #2257: the watch knows a prompt it followed from the agent's start, or once it saw it emptied; a Backspace proves
// nothing, and a chunk MoltenTerm did not announce is someone else's.
func TestInputWatchKnowsWhichPromptItFollowed(t *testing.T) {
	run := molten.AgentRunInfo{BlockId: "b1", Agent: "claude", Running: true, Started: 1}
	w := makeInputWatch(func(string) (molten.AgentRunInfo, bool) { return run, true }, func(string) bool { return true })
	if st := w.state("b1"); st.Known {
		t.Fatalf("an agent that ran before the watch: %+v", st)
	}
	w.input("b1", []byte("\x7f"))
	if st := w.state("b1"); st.Known {
		t.Fatalf("a Backspace proved the prompt empty: %+v", st)
	}
	w.input("b1", []byte("\x03"))
	if st := w.state("b1"); !st.Known {
		t.Fatalf("Ctrl+C empties it: %+v", st)
	}
	run.Started = w.since + 1
	if st := w.state("b1"); !st.Known {
		t.Fatalf("an agent started after the watch: %+v", st)
	}
	w.expectOwn("b1", []byte("mine"))
	w.input("b1", []byte("not mine"))
	if st := w.state("b1"); !st.Foreign || st.Own {
		t.Fatalf("an unannounced chunk: %+v", st)
	}
}

func TestWritesText(t *testing.T) {
	for _, tc := range []struct {
		data string
		want bool
	}{
		{"a", true},
		{"\x7f", true},
		{"\x17", true},
		{"\x1b[A", false},
		{"\x1b[I\x1b[O", false},
		{"\r", false},
		{"\x15", false},
		{"\x03", false},
		{"\x1b[200~pasted\x1b[201~", true},
	} {
		if got := writesText([]byte(tc.data)); got != tc.want {
			t.Errorf("%q: got %v", tc.data, got)
		}
	}
}
