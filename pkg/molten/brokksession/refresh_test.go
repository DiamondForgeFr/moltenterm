// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// #2257: a session started before the brief changed (the brainstorm section, #2246) read the old one at its start, and
// an agent does not read its instructions file again: the current brief goes with the next message, once.
func TestARunningSessionGetsTheCurrentBriefWithTheNextMessage(t *testing.T) {
	t.Parallel()
	f := &fake{found: &Found{BlockId: "block-9"}, brief: "v2", answers: []TypeOutcome{{Sent: true}}}
	svc := MakeService(f.env())
	if got := svc.Say(context.Background(), Request{Text: "an idea for an app"}); got.Status != StatusSent {
		t.Fatalf("got %+v", got)
	}
	if len(f.typed) != 1 || !strings.Contains(f.typed[0], "BRIEF v2") || !strings.HasSuffix(f.typed[0], "\n\nan idea for an app") {
		t.Fatalf("typed %q, want the current brief, then the message", f.typed)
	}
	if strings.Join(f.marked, ",") != "block-9:v2" {
		t.Fatalf("recorded %v, want the version his agent now has", f.marked)
	}
	if got := svc.Say(context.Background(), Request{Text: "for children"}); got.Status != StatusSent {
		t.Fatalf("got %+v", got)
	}
	if f.typed[1] != "block-9:for children" {
		t.Fatalf("typed %q, want the message alone once his agent has the brief", f.typed[1])
	}
}

func TestABriefThatDidNotGoIsNotRecorded(t *testing.T) {
	t.Parallel()
	f := &fake{found: &Found{BlockId: "block-9"}, brief: "v2", answers: []TypeOutcome{{Retry: true}}}
	if got := MakeService(f.env()).Say(context.Background(), Request{Text: "hello"}); got.Status != StatusBusy {
		t.Fatalf("got %+v", got)
	}
	if len(f.marked) != 0 {
		t.Fatalf("recorded %v for a message his agent did not take", f.marked)
	}
}

// A session it starts reads the current brief at its start: its terminal records the version, and the message goes alone.
func TestAFreshSessionRecordsTheBriefItStartsWith(t *testing.T) {
	t.Parallel()
	f := &fake{agent: "claude", brief: "v2", answers: []TypeOutcome{{Sent: true}}}
	if got := MakeService(f.env()).Say(context.Background(), Request{WorkspaceId: "ws-1", Text: "hello"}); got.Status != StatusSent {
		t.Fatalf("got %+v", got)
	}
	if f.openedMet[0][BriefMetaKey] != "v2" || f.typed[0] != "block-1:hello" || len(f.marked) != 0 {
		t.Fatalf("meta %v, typed %q, marked %v", f.openedMet[0], f.typed, f.marked)
	}
}

// #2257: a human's text in his prompt is never touched; the window says so, with his terminal.
func TestSaySaysAHumansTextWaitsInHisPrompt(t *testing.T) {
	t.Parallel()
	f := &fake{found: &Found{BlockId: "block-9", TabId: "tab-9"}, answers: []TypeOutcome{{HumanDraft: true}}}
	got := MakeService(f.env()).Say(context.Background(), Request{Text: "hello"})
	if got.Status != StatusFailed || got.Reason != ReasonHumanDraft || got.TabId != "tab-9" {
		t.Fatalf("got %+v", got)
	}
}

// #2257, review: a prompt that may hold text from before a restart is never emptied on a guess: the window says so, and
// the developer's explicit clear goes with the next try; the session this call started is fresh.
func TestSayTellsAnUnknownPromptAndTakesTheDevelopersClear(t *testing.T) {
	t.Parallel()
	f := &fake{found: &Found{BlockId: "block-9", TabId: "tab-9"}, answers: []TypeOutcome{{UnknownPrompt: true}}}
	svc := MakeService(f.env())
	got := svc.Say(context.Background(), Request{Text: "hello"})
	if got.Status != StatusFailed || got.Reason != ReasonUnknownPrompt || f.opts[0].ClearPrompt || f.opts[0].Fresh {
		t.Fatalf("got %+v with %+v", got, f.opts)
	}
	f.answers = []TypeOutcome{{Sent: true}}
	if got := svc.Say(context.Background(), Request{Text: "hello", ClearPrompt: true}); got.Status != StatusSent || !f.opts[1].ClearPrompt {
		t.Fatalf("the developer's clear: %+v with %+v", got, f.opts)
	}
	g := &fake{agent: "claude", answers: []TypeOutcome{{Sent: true}}}
	if got := MakeService(g.env()).Say(context.Background(), Request{WorkspaceId: "ws-1", Text: "hello"}); got.Status != StatusSent || !g.opts[0].Fresh {
		t.Fatalf("a session this call started: %+v with %+v", got, g.opts)
	}
}

// #2257, review: an agent that never comes to rest is said plainly, not left as a plain "busy".
func TestSaySaysAnAgentThatNeverComesToRest(t *testing.T) {
	t.Parallel()
	f := &fake{found: &Found{BlockId: "block-9"}, answers: []TypeOutcome{{Retry: true, Unsettled: true}}}
	if got := MakeService(f.env()).Say(context.Background(), Request{Text: "hello"}); got.Status != StatusBusy || got.Reason != ReasonUnsettled {
		t.Fatalf("got %+v", got)
	}
}

// #2257, review: the human-draft record of a terminal is written in order, the latest value last, whatever the
// speed of each write: "typed, emptied, typed" never ends as "no human".
func TestHumanDraftRecordsEndOnTheLatestValue(t *testing.T) {
	t.Parallel()
	var lock sync.Mutex
	written := map[string]bool{}
	release := make(chan struct{})
	first := true
	r := makeDraftRecorder(func(blockId string, foreign bool) {
		lock.Lock()
		wait := first
		first = false
		lock.Unlock()
		if wait {
			<-release
		}
		lock.Lock()
		defer lock.Unlock()
		written[blockId] = foreign
	})
	r.record("b1", true)
	r.record("b1", false)
	r.record("b1", true)
	close(release)
	deadline := time.Now().Add(time.Minute)
	for {
		lock.Lock()
		got, ok := written["b1"]
		lock.Unlock()
		r.lock.Lock()
		idle := !r.running["b1"]
		r.lock.Unlock()
		if ok && idle {
			if !got {
				t.Fatal("the last value written is not the latest")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the writes never ended")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestCurrentBriefNamesWhatHisFolderHolds(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	version, text, err := currentBrief(dir, "B1")
	if err != nil || version != BriefVersion("B1") || text != "B1" {
		t.Fatalf("got %q %q %v", version, text, err)
	}
	if v2, _, _ := currentBrief(dir, "B1"); v2 != version {
		t.Fatal("the same text has another version")
	}
	if BriefVersion("B2") == version {
		t.Fatal("two texts share a version")
	}
	// The developer wrote both files: theirs is followed, and no brief of MoltenTerm's goes to his agent.
	mine := t.TempDir()
	for _, name := range briefFiles {
		if err := os.WriteFile(filepath.Join(mine, name), []byte("# mine\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if v, txt, _ := currentBrief(mine, BriefMarker+" v1 -->\nB"); v != "" || txt != "" {
		t.Fatalf("got %q %q for the developer's own brief", v, txt)
	}
}

// #2257: he stays available: long work goes to the background and his answer ends at once.
func TestTheBriefKeepsHimAvailable(t *testing.T) {
	t.Parallel()
	for _, want := range []string{"## Staying available", "background", "end your answer at once", "Never wait for it in your turn"} {
		if !strings.Contains(BriefText(false), want) {
			t.Errorf("the brief does not say %q", want)
		}
	}
}
