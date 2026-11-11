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

// #2257: Brokk's message is submitted with Enter when his agent is at rest and his prompt is known empty.
func TestOwnMessageIsSubmitted(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state AgentInputState
		facts OwnPromptFacts
	}{
		{"a prompt the watch saw emptied", AgentInputState{Known: true, Precise: true}, OwnPromptFacts{}},
		{"the agent this message started", AgentInputState{Precise: true}, OwnPromptFacts{Fresh: true}},
	} {
		f := claudeInputTerm()
		f.state = tc.state
		out := ownMessage(f, "an idea for an app", tc.facts)
		if out.Result != InputSent || !out.Submitted || strings.Join(f.input, "|") != pasteStart+"an idea for an app"+pasteEnd+"|\r" {
			t.Errorf("%s: got %+v, typed %q", tc.name, out, f.input)
		}
	}
}

// #2257: what MoltenTerm left in a prompt the watch followed is emptied first, so a retry never stacks the message.
func TestOwnMessageClearsWhatMoltenTermLeft(t *testing.T) {
	f := claudeInputTerm()
	f.state = AgentInputState{Draft: true, Own: true, Known: true, Precise: true}
	out := ownMessage(f, "again", OwnPromptFacts{})
	if out.Result != InputSent || strings.Join(f.input, "|") != keyClearInput+"|"+pasteStart+"again"+pasteEnd+"|\r" {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
}

// #2257, review: after a restart the prompt may hold anything. It is never emptied on a guess nor sent with the
// message: nothing is typed until the developer chooses, in his layer, to empty it.
func TestOwnMessageNeverClearsAnUnknownPromptOnAGuess(t *testing.T) {
	f := claudeInputTerm()
	f.state = AgentInputState{Known: false, Precise: true}
	out := ownMessage(f, "hello", OwnPromptFacts{})
	if out.Result != InputRefused || out.Reason != InputReasonUnknownPrompt || len(f.input) != 0 {
		t.Fatalf("an unknown prompt: %+v, typed %q", out, f.input)
	}
	g := claudeInputTerm()
	g.state = AgentInputState{Known: false, Precise: true}
	out = ownMessage(g, "hello", OwnPromptFacts{ClearConfirmed: true})
	if out.Result != InputSent || strings.Join(g.input, "|") != keyClearInput+"|"+pasteStart+"hello"+pasteEnd+"|\r" {
		t.Fatalf("the developer's clear: %+v, typed %q", out, g.input)
	}
}

// #2257: a human's text in his prompt is never sent nor cleared: nothing is typed, unless the developer chooses to
// empty it.
func TestOwnMessageLeavesAHumansTextAlone(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state AgentInputState
		facts OwnPromptFacts
	}{
		{"seen by the watch", AgentInputState{Draft: true, Foreign: true, Known: true, Precise: true}, OwnPromptFacts{}},
		{"remembered across a restart", AgentInputState{Known: false, Precise: true}, OwnPromptFacts{HumanTyped: true}},
		// Review: a session started by a hook record after a restart is not "fresh" for what a human left there.
		{"remembered, whatever the run's start", AgentInputState{Known: false, Precise: true}, OwnPromptFacts{HumanTyped: true}},
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
		{"a call pending or a turn open", OwnPromptFacts{AtRest: atRest(false)}, false},
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

// #2257, review: a turn that starts while the message is pasted (a background task finishing) is never answered with
// Enter: the line stays, as MoltenTerm's own, for the next try to empty.
func TestOwnMessageAsksAgainBeforeEnter(t *testing.T) {
	f := claudeInputTerm()
	f.state = AgentInputState{Known: true, Precise: true}
	env := f.env()
	send := env.SendInput
	env.SendInput = func(blockId string, data []byte) error {
		if err := send(blockId, data); err != nil {
			return err
		}
		if strings.HasPrefix(string(data), pasteStart) {
			f.lock.Lock()
			f.run.State = molten.AgentStateWorking
			f.lock.Unlock()
		}
		return nil
	}
	out := MakeUpdater(env).typeOwnMessage(context.Background(), "b1", "hello", OwnPromptFacts{})
	if out.Result != InputRefused || out.Reason != InputReasonWorking || strings.Join(f.input, "|") != pasteStart+"hello"+pasteEnd {
		t.Fatalf("got %+v, typed %q", out, f.input)
	}
	rest := true
	g := claudeInputTerm()
	g.state = AgentInputState{Known: true, Precise: false}
	env = g.env()
	send = env.SendInput
	env.SendInput = func(blockId string, data []byte) error {
		if strings.HasPrefix(string(data), pasteStart) {
			rest = false
		}
		return send(blockId, data)
	}
	out = MakeUpdater(env).typeOwnMessage(context.Background(), "b1", "hello", OwnPromptFacts{AtRest: func() bool { return rest }})
	if out.Result != InputRefused || out.Reason != InputReasonUnsettled || strings.Contains(strings.Join(g.input, "|"), "\r") {
		t.Fatalf("a transcript no longer at rest: %+v, typed %q", out, g.input)
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

// watchedTerm wires the real input watch to the fake terminal: what is sent comes back as the terminal's input.
func watchedTerm(t *testing.T) (*inputTerm, *inputWatch, *Updater, *molten.AgentRunInfo) {
	f := claudeInputTerm()
	run := f.run
	run.Started = 1
	w := makeInputWatch(func(string) (molten.AgentRunInfo, bool) { return run, true }, func(string) bool { return true })
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
	env.WatchOwn = w.watchOwn
	return f, w, MakeUpdater(env), &run
}

// #2257, end to end with the input watch: an unknown prompt is left alone; the developer's clear empties it; a
// leftover of MoltenTerm's own is emptied; a human's key makes it theirs and nothing is typed; once they empty the
// prompt, the message goes without clearing anything.
func TestOwnMessageFollowsWhoseTextIsInThePrompt(t *testing.T) {
	f, w, u, _ := watchedTerm(t)
	var told []bool
	w.watchOwn("b1", func(foreign bool) { told = append(told, foreign) })
	say := func(text string, facts OwnPromptFacts) AgentInputResult {
		return u.typeOwnMessage(context.Background(), "b1", text, facts)
	}

	// A restart: the agent ran before the watch, which knows nothing of its prompt.
	if out := say("first", OwnPromptFacts{}); out.Reason != InputReasonUnknownPrompt || len(f.input) != 0 {
		t.Fatalf("an unknown prompt was touched: %+v, typed %q", out, f.input)
	}
	if out := say("first", OwnPromptFacts{ClearConfirmed: true}); out.Result != InputSent || f.input[0] != keyClearInput {
		t.Fatalf("the developer's clear: %+v, typed %q", out, f.input)
	}
	if st := w.state("b1"); !st.Known || st.Draft || st.Foreign {
		t.Fatalf("after a submitted message: %+v", st)
	}
	// A try left MoltenTerm's own line without Enter.
	f.input = nil
	w.expectOwn("b1", []byte(pasteStart+"left"+pasteEnd))
	w.input("b1", []byte(pasteStart+"left"+pasteEnd))
	if st := w.state("b1"); !st.Own || st.Foreign {
		t.Fatalf("MoltenTerm's leftover: %+v", st)
	}
	if out := say("second", OwnPromptFacts{}); out.Result != InputSent || strings.Join(f.input, "|") != keyClearInput+"|"+pasteStart+"second"+pasteEnd+"|\r" {
		t.Fatalf("the leftover is emptied, not stacked: %+v, typed %q", out, f.input)
	}
	// A human types in his terminal.
	f.input = nil
	w.input("b1", []byte("my own note"))
	if out := say("third", OwnPromptFacts{}); out.Result != InputRefused || out.Reason != InputReasonHumanDraft || len(f.input) != 0 {
		t.Fatalf("a human's text was touched: %+v, typed %q", out, f.input)
	}
	// Arrow keys and terminal answers write no text.
	w.input("b1", []byte("\x1b[A\x1b[I"))
	// They clear it themselves.
	w.input("b1", []byte("\x15"))
	if out := say("fourth", OwnPromptFacts{}); out.Result != InputSent || strings.Join(f.input, "|") != pasteStart+"fourth"+pasteEnd+"|\r" {
		t.Fatalf("an emptied prompt: %+v, typed %q", out, f.input)
	}
	if !strings.Contains(boolList(told), "true,false") {
		t.Fatalf("the owner was told %v, want the human's text coming in, then the prompt emptied", told)
	}
}

// #2257, review: a hand-off typed into his terminal is not MoltenTerm's own message: it is never cleared.
func TestAHandoffIsNeverTakenForMoltenTermsOwnText(t *testing.T) {
	f, w, u, _ := watchedTerm(t)
	w.input("b1", []byte("\x15"))
	f.state.Draft = true
	if out := u.TypeLine(context.Background(), "b1", "[From Camille] look at #12"); out.Result != InputSent {
		t.Fatalf("the hand-off line: %+v", out)
	}
	if st := w.state("b1"); !st.Foreign || st.Own {
		t.Fatalf("a hand-off counted as MoltenTerm's own text: %+v", st)
	}
	f.input = nil
	if out := u.typeOwnMessage(context.Background(), "b1", "hello", OwnPromptFacts{}); out.Reason != InputReasonHumanDraft || len(f.input) != 0 {
		t.Fatalf("the hand-off would be cleared: %+v, typed %q", out, f.input)
	}
}

// #2257, review: a human's text typed before the owner asked for the watch is told at once; the owner is told the
// prompt is emptied only when the watch sees it emptied.
func TestTheOwnerLearnsOfAHumansTextTypedBefore(t *testing.T) {
	_, w, _, _ := watchedTerm(t)
	w.input("b1", []byte("\x15"))
	w.input("b1", []byte("typed before"))
	var told []bool
	w.watchOwn("b1", func(foreign bool) { told = append(told, foreign) })
	if boolList(told) != "true" {
		t.Fatalf("told %v, want the text already there", told)
	}
	w.watchOwn("b1", func(foreign bool) { told = append(told, foreign) })
	if boolList(told) != "true" {
		t.Fatalf("a second registration told again: %v", told)
	}
	w.input("b1", []byte("\x7f"))
	if boolList(told) != "true" {
		t.Fatalf("a Backspace said the prompt is empty: %v", told)
	}
	w.input("b1", []byte("\r"))
	if boolList(told) != "true,false" {
		t.Fatalf("told %v, want the prompt emptied", told)
	}
}

func boolList(list []bool) string {
	words := make([]string, 0, len(list))
	for _, b := range list {
		if b {
			words = append(words, "true")
		} else {
			words = append(words, "false")
		}
	}
	return strings.Join(words, ",")
}

// #2257, review: the watch knows a prompt only once it saw it emptied; when the run seems to have started says
// nothing (a hook makes the record after a restart); a Backspace proves nothing; a chunk MoltenTerm did not announce
// is someone else's.
func TestInputWatchKnowsWhichPromptItFollowed(t *testing.T) {
	run := molten.AgentRunInfo{BlockId: "b1", Agent: "claude", Running: true, Started: 1}
	w := makeInputWatch(func(string) (molten.AgentRunInfo, bool) { return run, true }, func(string) bool { return true })
	if st := w.state("b1"); st.Known {
		t.Fatalf("an agent that ran before the watch: %+v", st)
	}
	run.Started = 1 << 62
	if st := w.state("b1"); st.Known {
		t.Fatalf("a run record made after the watch started: %+v", st)
	}
	w.input("b1", []byte("\x7f"))
	if st := w.state("b1"); st.Known {
		t.Fatalf("a Backspace proved the prompt empty: %+v", st)
	}
	w.input("b1", []byte("\x03"))
	if st := w.state("b1"); !st.Known {
		t.Fatalf("Ctrl+C empties it: %+v", st)
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
