// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"context"
	"fmt"
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
