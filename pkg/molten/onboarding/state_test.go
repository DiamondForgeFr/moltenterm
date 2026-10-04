// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const testNow = int64(1_800_000_000_000)
const testVersion = "1.0.0-0"

func TestSkipRequested(t *testing.T) {
	for _, v := range []string{"1", "true", "TRUE", " True "} {
		if !SkipRequested(v) {
			t.Errorf("SkipRequested(%q) = false", v)
		}
	}
	for _, v := range []string{"", "0", "false", "yes", "2"} {
		if SkipRequested(v) {
			t.Errorf("SkipRequested(%q) = true", v)
		}
	}
}

// metaRoundTrip stores the state as the client meta does and reads it back after a JSON round trip (the database).
func metaRoundTrip(t *testing.T, state State) waveobj.MetaMapType {
	t.Helper()
	meta := waveobj.MetaMapType{MetaKey: MetaValue(state)}
	raw, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	var rtn waveobj.MetaMapType
	if err := json.Unmarshal(raw, &rtn); err != nil {
		t.Fatal(err)
	}
	return rtn
}

func TestReadState(t *testing.T) {
	if _, ok := ReadState(nil); ok {
		t.Error("nil meta read as a state")
	}
	if _, ok := ReadState(waveobj.MetaMapType{MetaKey: "garbage"}); ok {
		t.Error("a string read as a state")
	}
	want := State{
		V: 1, Done: true, By: ByFinish, StartedTs: 1, WelcomeTs: 2, DoneTs: 3,
		Steps:       map[string]string{StepAgent: StatusDone, StepMorph: StatusSkipped},
		Data:        map[string]map[string]any{StepAgent: {"agents": []any{"claude-code"}}},
		LastVersion: testVersion,
	}
	got, ok := ReadState(metaRoundTrip(t, want))
	if !ok {
		t.Fatal("state not read")
	}
	if got.By != ByFinish || !got.Done || got.Steps[StepMorph] != StatusSkipped || got.LastVersion != testVersion {
		t.Errorf("state read as %+v", got)
	}
	agents, _ := got.Data[StepAgent]["agents"].([]any)
	if len(agents) != 1 || agents[0] != "claude-code" {
		t.Errorf("step data read as %+v", got.Data)
	}
}

func TestDecideStart(t *testing.T) {
	running := State{V: 1, StartedTs: 1}
	done := State{V: 1, Done: true, By: ByFinish, LastVersion: "0.9.0"}
	cases := []struct {
		name     string
		facts    StartFacts
		write    bool
		by       string
		done     bool
		setTos   bool
		layout   string
		announce string
	}{
		{name: "fresh", facts: StartFacts{FirstTabEmpty: true}, write: true, layout: LayoutFirstRun},
		{name: "fresh, tab not empty", facts: StartFacts{}, write: true, layout: LayoutNone},
		{name: "skip on a fresh dir", facts: StartFacts{Skip: true, FirstTabEmpty: true}, write: true, done: true, by: ByEnv, setTos: true, layout: LayoutStarter},
		{name: "skip, tab not empty", facts: StartFacts{Skip: true}, write: true, done: true, by: ByEnv, setTos: true},
		{name: "skip, terms already accepted", facts: StartFacts{Skip: true, TosAgreed: true, FirstTabEmpty: true}, write: true, done: true, by: ByEnv},
		{name: "skip on a run in progress", facts: StartFacts{Skip: true, HasState: true, State: running, HasPanel: true}, write: true, done: true, by: ByEnv, setTos: true},
		{name: "skip on a run done", facts: StartFacts{Skip: true, HasState: true, State: done, TosAgreed: true}},
		{name: "existing install", facts: StartFacts{TosAgreed: true}, write: true, done: true, by: ByExisting, announce: AnnounceAvailable},
		{name: "run in progress with its panel", facts: StartFacts{HasState: true, State: running, HasPanel: true}},
		{name: "panel closed", facts: StartFacts{HasState: true, State: running}, write: true, done: true, by: ByClosed, setTos: true, announce: AnnounceLeft},
		{name: "panel closed after the welcome", facts: StartFacts{HasState: true, State: running, TosAgreed: true}, write: true, done: true, by: ByClosed, announce: AnnounceLeft},
		{name: "run done", facts: StartFacts{HasState: true, State: done, TosAgreed: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := DecideStart(tc.facts, testNow, testVersion)
			if out.Write != tc.write || out.SetTos != tc.setTos || out.Layout != tc.layout || out.Announce != tc.announce {
				t.Fatalf("outcome %+v", out)
			}
			if !tc.write {
				return
			}
			if out.State.Done != tc.done || out.State.By != tc.by {
				t.Errorf("state %+v", out.State)
			}
			if out.State.V != StateVersion || out.State.StartedTs == 0 {
				t.Errorf("state version or start missing: %+v", out.State)
			}
			if tc.done && (out.State.DoneTs != testNow || out.State.LastVersion != testVersion) {
				t.Errorf("done without its time or version: %+v", out.State)
			}
		})
	}
}

func TestDecideStartKeepsSteps(t *testing.T) {
	running := State{V: 1, StartedTs: 1, Steps: map[string]string{StepAgent: StatusDone}}
	out := DecideStart(StartFacts{HasState: true, State: running}, testNow, testVersion)
	if out.State.Steps[StepAgent] != StatusDone {
		t.Errorf("steps lost: %+v", out.State)
	}
	if running.Done {
		t.Error("the input state was modified")
	}
}

func TestDecideClosed(t *testing.T) {
	running := State{V: 1, StartedTs: 1}
	if out := DecideClosed(running, true, false, true, testNow, testVersion); out.Write {
		t.Error("a run with a panel left was closed")
	}
	if out := DecideClosed(running, false, false, false, testNow, testVersion); out.Write {
		t.Error("no record, yet closed")
	}
	if out := DecideClosed(State{Done: true}, true, true, false, testNow, testVersion); out.Write {
		t.Error("a run done was closed again")
	}
	out := DecideClosed(running, true, false, false, testNow, testVersion)
	if !out.Write || !out.State.Done || out.State.By != ByClosed || !out.SetTos || out.Announce != AnnounceLeft {
		t.Errorf("closed outcome %+v", out)
	}
}

func apply(t *testing.T, state State, hasState bool, tos bool, update Update) Outcome {
	t.Helper()
	out, err := ApplyUpdate(state, hasState, tos, update, testNow, testVersion)
	if err != nil {
		t.Fatalf("update %+v: %v", update, err)
	}
	return out
}

func TestApplyUpdateWelcome(t *testing.T) {
	out := apply(t, State{V: 1, StartedTs: 1}, true, false, Update{Kind: UpdateWelcome})
	if !out.SetTos || out.State.WelcomeTs != testNow || out.State.Done {
		t.Errorf("welcome outcome %+v", out)
	}
	again, err := ApplyUpdate(out.State, true, true, Update{Kind: UpdateWelcome}, testNow+5, testVersion)
	if err != nil || again.State.WelcomeTs != testNow || again.SetTos {
		t.Errorf("welcome is not idempotent: %+v %v", again, err)
	}
	fresh := apply(t, State{}, false, false, Update{Kind: UpdateWelcome})
	if fresh.State.V != StateVersion || fresh.State.StartedTs != testNow {
		t.Errorf("welcome without a record: %+v", fresh.State)
	}
}

func TestApplyUpdateSteps(t *testing.T) {
	state := State{V: 1, StartedTs: 1, WelcomeTs: 2}
	out := apply(t, state, true, true, Update{Kind: UpdateStep, Step: StepAgent, Status: StatusDone})
	out = apply(t, out.State, true, true, Update{Kind: UpdateStep, Step: StepMorph, Status: StatusSkipped})
	if out.State.Steps[StepAgent] != StatusDone || out.State.Steps[StepMorph] != StatusSkipped {
		t.Errorf("steps %+v", out.State.Steps)
	}
	if state.Steps != nil {
		t.Error("the input state was modified")
	}
	out = apply(t, out.State, true, true, Update{Kind: UpdateStep, Step: StepMorph, Status: StatusTodo})
	if _, found := out.State.Steps[StepMorph]; found {
		t.Errorf("todo kept the step: %+v", out.State.Steps)
	}
	if out.SetTos || out.Announce != AnnounceNone {
		t.Errorf("a step recorded terms or announced: %+v", out)
	}
	if _, err := ApplyUpdate(state, true, true, Update{Kind: UpdateStep, Step: "tour", Status: StatusDone}, testNow, testVersion); err == nil {
		t.Error("unknown step accepted")
	}
	if _, err := ApplyUpdate(state, true, true, Update{Kind: UpdateStep, Step: StepAgent, Status: "maybe"}, testNow, testVersion); err == nil {
		t.Error("unknown status accepted")
	}
	if _, err := ApplyUpdate(state, true, true, Update{Kind: "reset"}, testNow, testVersion); err == nil {
		t.Error("unknown update accepted")
	}
}

func TestApplyUpdateData(t *testing.T) {
	state := State{V: 1, Data: map[string]map[string]any{StepAgent: {"agents": []any{"codex"}, "keep": true}}}
	out := apply(t, state, true, true, Update{Kind: UpdateData, Step: StepAgent, Data: map[string]any{"agents": []any{"claude-code"}, "keep": nil, "new": "x"}})
	got := out.State.Data[StepAgent]
	if _, found := got["keep"]; found || got["new"] != "x" {
		t.Errorf("data merge %+v", got)
	}
	if agents, _ := got["agents"].([]any); len(agents) != 1 || agents[0] != "claude-code" {
		t.Errorf("data merge %+v", got)
	}
	if state.Data[StepAgent]["keep"] != true {
		t.Error("the input state was modified")
	}
	big := map[string]any{"blob": strings.Repeat("x", MaxStepDataBytes)}
	if _, err := ApplyUpdate(state, true, true, Update{Kind: UpdateData, Step: StepAgent, Data: big}, testNow, testVersion); err == nil {
		t.Error("oversized step data accepted")
	}
	if _, err := ApplyUpdate(state, true, true, Update{Kind: UpdateData, Step: "other"}, testNow, testVersion); err == nil {
		t.Error("data for an unknown step accepted")
	}
}

func TestApplyUpdateLeaveAndFinish(t *testing.T) {
	running := State{V: 1, StartedTs: 1, WelcomeTs: 2}
	left := apply(t, running, true, false, Update{Kind: UpdateLeave})
	if !left.State.Done || left.State.By != ByLeave || left.State.DoneTs != testNow || left.State.LastVersion != testVersion {
		t.Errorf("leave %+v", left.State)
	}
	if !left.SetTos || left.Announce != AnnounceLeft {
		t.Errorf("leave outcome %+v", left)
	}
	again, err := ApplyUpdate(left.State, true, true, Update{Kind: UpdateLeave}, testNow+10, "2.0.0")
	if err != nil || again.State.DoneTs != testNow || again.State.LastVersion != testVersion || again.Announce != AnnounceNone {
		t.Errorf("leave is not idempotent: %+v %v", again, err)
	}
	finished := apply(t, running, true, true, Update{Kind: UpdateFinish})
	if !finished.State.Done || finished.State.By != ByFinish || finished.Announce != AnnounceNone || finished.SetTos {
		t.Errorf("finish %+v", finished)
	}
	// A run reopened later and finished again keeps the version #188 compares.
	reopened := apply(t, State{V: 1, Done: true, By: ByExisting}, true, true, Update{Kind: UpdateFinish})
	if reopened.State.By != ByExisting || reopened.State.LastVersion != testVersion {
		t.Errorf("finish after reopen %+v", reopened.State)
	}
}

func TestNotificationFor(t *testing.T) {
	if _, ok := NotificationFor(AnnounceNone); ok {
		t.Error("no announce, yet a notification")
	}
	for _, what := range []string{AnnounceAvailable, AnnounceLeft} {
		input, ok := NotificationFor(what)
		if !ok || input.Key != NotificationKey || len(input.Actions) != 1 || input.Actions[0].Gesture != OpenGesture {
			t.Errorf("notification for %q: %+v", what, input)
		}
	}
}

func TestHasPanelBlocks(t *testing.T) {
	term := &waveobj.Block{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}}
	panel := &waveobj.Block{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: ViewType}}
	if HasPanelBlocks([]*waveobj.Block{term, nil}) {
		t.Error("a terminal counted as the panel")
	}
	if !HasPanelBlocks([]*waveobj.Block{term, panel}) {
		t.Error("the panel was not found")
	}
}
