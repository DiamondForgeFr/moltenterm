// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A request MoltenTerm queued for a lead is the developer's click of a moment, not of the hour it may wait (#2145,
// FR-REV-022 AC22): it is not queued twice, it is dropped without a word when its PR changed meanwhile, and when it
// expires it is told calmly, with Resend, only if it still applies.

func (e *fakeEnv) endRun(blockId string) {
	e.lock.Lock()
	defer e.lock.Unlock()
	r := e.runs[blockId]
	r.Running = false
	e.runs[blockId] = r
}

func TestAQueuedAppRequestIsNotQueuedTwice(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	env.setState("blockB", molten.AgentStateWorking)
	first, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "Resume PR #9.", Key: "finish|acme/app#9|0123"})
	if err != nil || first.Status != StatusQueued {
		t.Fatalf("first: %+v %v", first, err)
	}
	again, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "Resume PR #9.", Key: "finish|acme/app#9|0123"})
	if err != nil || again.Status != StatusQueued || again.BriefPath != first.BriefPath {
		t.Fatalf("the same task: %+v %v", again, err)
	}
	other, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "Resume PR #9.", Key: "finish|acme/app#9|4567"})
	if err != nil || other.BriefPath == first.BriefPath {
		t.Fatalf("a new head is another task: %+v %v", other, err)
	}
	env.setState("blockB", molten.AgentStateIdle)
	waitFor(t, "the two requests typed", func() bool { return len(env.typedLines()) == 2 })
}

func TestAQueuedAppRequestThatNoLongerAppliesIsDroppedSilently(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.appliesEvery = 0
	var applies atomic.Bool
	applies.Store(true)
	env.setState("blockB", molten.AgentStateWorking)
	sent, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "Resume PR #9.",
		Applies: func(ctx context.Context) bool { return applies.Load() }})
	if err != nil || sent.Status != StatusQueued {
		t.Fatalf("queued: %+v %v", sent, err)
	}
	applies.Store(false)
	waitFor(t, "the request dropped", func() bool { return !m.hasQueue("blockB") })
	env.setState("blockB", molten.AgentStateIdle)
	if len(env.typedLines()) != 0 || len(env.notifications()) != 0 {
		t.Fatalf("a request that no longer applies is neither typed nor told: %+v %+v", env.typedLines(), env.notifications())
	}
}

// Asked again right before it is typed, a request that stopped applying while its receiver worked is not typed.
func TestAQueuedAppRequestIsCheckedBeforeItIsTyped(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.appliesEvery = time.Hour
	var asked atomic.Int32
	env.setState("blockB", molten.AgentStateWorking)
	if _, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "Resume PR #9.",
		Applies: func(ctx context.Context) bool { return asked.Add(1) == 1 }}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the first check", func() bool { return asked.Load() >= 1 })
	env.setState("blockB", molten.AgentStateIdle)
	waitFor(t, "the request dropped", func() bool { return !m.hasQueue("blockB") })
	if len(env.typedLines()) != 0 || len(env.notifications()) != 0 {
		t.Fatalf("typed %+v told %+v", env.typedLines(), env.notifications())
	}
}

func TestAnExpiredAppRequestThatStillAppliesIsCalmWithResend(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.queueTimeout = -1
	resend := molten.NotificationAction{Id: "resend", Label: "Resend", Kind: "gesture", Gesture: "reviews:resend", Args: map[string]any{"number": 9}}
	env.setState("blockB", molten.AgentStateWorking)
	if _, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "Resume PR #9.",
		Applies: func(ctx context.Context) bool { return true }, Resend: &resend}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the notice", func() bool { return len(env.notifications()) == 1 })
	note := env.notifications()[0]
	if note.Kind != "info" || note.TitleText == nil || note.TitleText.Code != "handoff.expired.title" || note.TitleText.Vars["receiver"] != "Jérôme" ||
		note.MessageText == nil || note.MessageText.Code != "handoff.expired.message" || note.MessageText.Parts["reason"].Code != "handoff.undelivered.timeout" {
		t.Fatalf("notice: %+v", note)
	}
	if len(note.Actions) != 1 || note.Actions[0].Gesture != "reviews:resend" || note.Actions[0].Args["number"] != 9 {
		t.Fatalf("the Resend action: %+v", note.Actions)
	}
	if !strings.Contains(note.Message, "nothing needs your approval") {
		t.Fatalf("english: %q", note.Message)
	}
}

// Asked first, a request whose state changed while it waited says nothing when it expires.
func TestAnExpiredAppRequestThatNoLongerAppliesSaysNothing(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.queueTimeout = -1
	m.appliesEvery = time.Hour
	var asked atomic.Int32
	env.setState("blockB", molten.AgentStateWorking)
	if _, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "Resume PR #9.",
		Applies: func(ctx context.Context) bool { return asked.Add(1) == 1 }}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the request out of the queue", func() bool { return !m.hasQueue("blockB") && asked.Load() >= 2 })
	if len(env.notifications()) != 0 || len(env.typedLines()) != 0 {
		t.Fatalf("told %+v typed %+v", env.notifications(), env.typedLines())
	}
}

// A receiver that ended before its prompt was idle is told the same calm way, or not at all.
func TestAnAppRequestWhoseReceiverEndedIsToldCalmlyOrNotAtAll(t *testing.T) {
	for _, applies := range []bool{true, false} {
		m, env, _, _ := makeFixture(t)
		m.appliesEvery = time.Hour
		var asked atomic.Int32
		env.setState("blockB", molten.AgentStateWorking)
		if _, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "Resume PR #9.",
			Applies: func(ctx context.Context) bool { return asked.Add(1) == 1 || applies }}); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "the first check", func() bool { return asked.Load() >= 1 })
		env.endRun("blockB")
		waitFor(t, "the request out of the queue", func() bool { return !m.hasQueue("blockB") && asked.Load() >= 2 })
		notes := env.notifications()
		if applies && (len(notes) != 1 || notes[0].Kind != "info" || notes[0].MessageText.Parts["reason"].Code != "handoff.undelivered.ended") {
			t.Fatalf("still applies: %+v", notes)
		}
		if !applies && len(notes) != 0 {
			t.Fatalf("no longer applies: %+v", notes)
		}
	}
}
