// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #1926: the sender never waits for the developer. A MoltenTerm built as shipped returns pending at once.
func TestTheDefaultSendDoesNotWaitForTheDeveloper(t *testing.T) {
	_, env, _, _ := makeFixture(t)
	if m := MakeManager(env); m.approvalTimeout > 0 {
		t.Fatalf("the sender waits %v for the developer's answer", m.approvalTimeout)
	}
}

type logLines struct {
	lock  sync.Mutex
	lines []string
}

func (l *logLines) logf(format string, args ...any) {
	l.lock.Lock()
	defer l.lock.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logLines) text() string {
	l.lock.Lock()
	defer l.lock.Unlock()
	return strings.Join(l.lines, "")
}

// #1926: the first send returns pending at once; the request is in the window's list (any workspace) and its
// notification; Allow once delivers the brief and tells the sender; each step is logged without the brief's words.
func TestFirstSendIsPendingListedAnsweredAndLogged(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.approvalTimeout = 0
	logs := &logLines{}
	m.logf = logs.logf
	var changes atomic.Int32
	m.pendingChanged = func() { changes.Add(1) }

	const goal = "Rewrite the secret parser"
	res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: goal}})
	if err != nil || res.Status != StatusPending || !strings.HasPrefix(res.Message, "Pending: waiting for the developer's approval") {
		t.Fatalf("first send: %+v %v", res, err)
	}
	if len(env.typedLines()) != 0 {
		t.Fatalf("typed before the answer: %+v", env.typedLines())
	}
	notes := env.notifications()
	if len(notes) != 1 || len(notes[0].Actions) != 3 {
		t.Fatalf("the ask: %+v", notes)
	}
	id := notes[0].Actions[0].Args["requestid"].(string)
	if changes.Load() == 0 {
		t.Fatal("the windows were not told a request waits")
	}

	if _, err := m.Pending("blockA"); err == nil {
		t.Fatal("a terminal read the pending requests")
	}
	list, err := m.Pending("tab:other-workspace")
	if err != nil || len(list.Entries) != 1 {
		t.Fatalf("pending list: %+v %v", list, err)
	}
	e := list.Entries[0]
	if e.RequestId != id || e.FromBlockId != "blockA" || e.ToBlockId != "blockB" || e.From != "Camille" || e.To != "Jérôme" ||
		e.Goal != goal || e.CreatedAt == 0 {
		t.Fatalf("pending entry: %+v", e)
	}

	before := changes.Load()
	if err := m.Answer("tab:abc", AnswerRequest{RequestId: id, Decision: DecisionOnce}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the brief and the receipt", func() bool { return len(env.typedLines()) == 2 })
	if lines := env.typedLines(); lines[0].blockId != "blockB" || lines[1].blockId != "blockA" || !strings.HasPrefix(lines[1].line, receiptPrefix) {
		t.Fatalf("delivery: %+v", lines)
	}
	if changes.Load() == before {
		t.Fatal("the windows were not told the request was answered")
	}
	if list, _ := m.Pending("tab:abc"); len(list.Entries) != 0 {
		t.Fatalf("still pending after the answer: %+v", list)
	}

	waitFor(t, "the delivery logged", func() bool { return strings.Contains(logs.text(), "delivered") })
	text := logs.text()
	for _, step := range []string{"requested", "asked the developer request=" + id, `answered "once" request=` + id, "delivered"} {
		if !strings.Contains(text, step) {
			t.Fatalf("log lacks %q:\n%s", step, text)
		}
	}
	if strings.Contains(text, "secret parser") {
		t.Fatalf("the log holds the brief's words:\n%s", text)
	}
}

// #1891: the card that answers a request reads where each end works and the brief it would get, which the connections
// menu's poll does not carry. The brief is the sender's words; no file is opened to show it.
func TestPendingListCarriesTheBriefForTheCardOnly(t *testing.T) {
	m, _, projA, _ := makeFixture(t)
	m.approvalTimeout = 0
	longContext := strings.Repeat("c", maxPendingContext+500)
	brief := Brief{
		Goal:    "Rewrite the secret parser\nand keep the tests green",
		Context: longContext,
		Files:   []FileRef{{Path: "notes.md", Lines: "4-9", Note: "the old behaviour", Excerpt: strings.Repeat("e", maxPendingExcerpt+10)}},
		Links:   []LinkRef{{Url: "https://example.com/doc", Title: "The doc", Kind: LinkKindUrl, Note: "read first"}},
		Reply:   true,
	}
	if res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: brief}); err != nil || res.Status != StatusPending {
		t.Fatalf("send: %+v %v", res, err)
	}

	list, err := m.Pending("tab:any")
	if err != nil || len(list.Entries) != 1 {
		t.Fatalf("pending: %+v %v", list, err)
	}
	e := list.Entries[0]
	if e.FromWorkspace != "A" || e.ToWorkspace != "B" || e.FromProject != "projecta" || e.ToProject != "projectb" {
		t.Fatalf("where each end works: %+v", e)
	}
	if strings.Contains(e.Goal, "\n") || e.Brief == nil || e.Brief.Goal != "Rewrite the secret parser\nand keep the tests green" || !e.Brief.Reply {
		t.Fatalf("goal: line %q, brief %+v", e.Goal, e.Brief)
	}
	if n := len([]rune(e.Brief.Context)); n != maxPendingContext {
		t.Fatalf("the context is cut for a window to %d characters, got %d", maxPendingContext, n)
	}
	if len(e.Brief.Files) != 1 || e.Brief.Files[0].Path != filepath.Join(projA, "notes.md") || e.Brief.Files[0].Lines != "4-9" ||
		e.Brief.Files[0].Note != "the old behaviour" || len([]rune(e.Brief.Files[0].Excerpt)) != maxPendingExcerpt {
		t.Fatalf("files: %+v", e.Brief.Files)
	}
	if len(e.Brief.Links) != 1 || e.Brief.Links[0].Url != "https://example.com/doc" || e.Brief.Links[0].Title != "The doc" ||
		e.Brief.Links[0].Kind != LinkKindUrl || e.Brief.Links[0].Note != "read first" {
		t.Fatalf("links: %+v", e.Brief.Links)
	}

	pairs, err := m.Pairs(context.Background(), "tab:any", PairsRequest{BlockId: "blockA"})
	if err != nil || len(pairs.Pending) != 1 {
		t.Fatalf("pairs: %+v %v", pairs, err)
	}
	if p := pairs.Pending[0]; p.Brief != nil || p.FromWorkspace != "" || p.ToProject != "" {
		t.Fatalf("the connections menu's poll carries the brief: %+v", p)
	}
}

// A request is listed while it waits and leaves the list once answered, also when the sender still waits for it.
func TestPendingListsOnlyWaitingRequests(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.approvalTimeout = time.Hour
	answered := make(chan error, 1)
	env.onNotify = func(input molten.NotificationInput) {
		list, _ := m.Pending("tab:abc")
		if len(list.Entries) != 1 {
			answered <- fmt.Errorf("listed while waiting: %+v", list)
			return
		}
		answered <- m.Answer("tab:abc", AnswerRequest{RequestId: list.Entries[0].RequestId, Decision: DecisionOnce})
	}
	res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "x"}})
	if err != nil || res.Status == StatusPending {
		t.Fatalf("answered send: %+v %v", res, err)
	}
	if err := <-answered; err != nil {
		t.Fatal(err)
	}
	if list, _ := m.Pending("tab:abc"); len(list.Entries) != 0 {
		t.Fatalf("still listed: %+v", list)
	}
}
