// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"testing"
)

func TestHistoryKeepsPassedOnHandoffs(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	answerWith(m, env, DecisionAlways)
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "jerome", Brief: Brief{Goal: "Review\nthe parser"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Zoé", Brief: Brief{Goal: "nobody"}}); err == nil {
		t.Fatal("unknown receiver must be refused")
	}
	got, err := m.History("tab:abc")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Entries) != 1 {
		t.Fatalf("a refused send is not a handoff: %+v", got.Entries)
	}
	e := got.Entries[0]
	if e.FromBlockId != "blockA" || e.ToBlockId != "blockB" || e.From != "Camille" || e.To != "Jérôme" || e.Goal != "Review the parser" || e.At == 0 {
		t.Fatalf("entry: %+v", e)
	}
	if _, err := m.History("block:blockA"); err == nil {
		t.Fatal("only a window reads the history")
	}
}

func TestHistoryIsBounded(t *testing.T) {
	m, _, _, _ := makeFixture(t)
	for i := 0; i < maxHistory+5; i++ {
		m.addHistory(Party{BlockId: "a"}, Party{BlockId: "b"}, Brief{Goal: "g"})
	}
	got, _ := m.History("electron")
	if len(got.Entries) != maxHistory {
		t.Fatalf("history: %d entries", len(got.Entries))
	}
}
