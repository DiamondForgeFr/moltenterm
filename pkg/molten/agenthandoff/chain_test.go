// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"context"
	"sync/atomic"
	"testing"
)

func TestHandoffRecordsTheLeadToSubAgentLink(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.chain = OpenChain(env.dataDir)
	var changes atomic.Int32
	m.chainChanged = func() { changes.Add(1) }
	answerWith(m, env, DecisionAlways)
	if res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "take the CSV export"}}); err != nil || res.Status != StatusDelivered {
		t.Fatalf("send: %+v %v", res, err)
	}
	chain, err := m.Chain("tab:abc")
	if err != nil {
		t.Fatal(err)
	}
	if len(chain.Edges) != 1 || chain.Edges[0].Lead != "Camille" || chain.Edges[0].Sub != "Jérôme" || chain.Edges[0].Via != "handoff" {
		t.Fatalf("chain after a handoff: %+v", chain.Edges)
	}
	if changes.Load() != 1 {
		t.Fatalf("the windows were told %d times, want once", changes.Load())
	}
	// A second handoff between the same two is the same link: the windows are not told again.
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "and the PDF"}}); err != nil {
		t.Fatal(err)
	}
	if changes.Load() != 1 {
		t.Fatalf("the windows were told %d times for a link already kept", changes.Load())
	}
	// A restart reads the same link back from the file.
	if again := OpenChain(env.dataDir).Edges(); len(again) != 1 || again[0].Lead != "Camille" || again[0].Sub != "Jérôme" {
		t.Fatalf("chain after a restart: %+v", again)
	}
}

func TestBlockedHandoffRecordsNoLink(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.chain = OpenChain(env.dataDir)
	answerWith(m, env, DecisionBlock)
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "x"}}); err == nil {
		t.Fatal("a blocked handoff was sent")
	}
	if got := m.chain.Edges(); len(got) != 0 {
		t.Fatalf("a refused handoff left a link: %+v", got)
	}
}

func TestOnlyAWindowReadsTheChain(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.chain = OpenChain(env.dataDir)
	if _, err := m.Chain("terminal:blockA"); err == nil {
		t.Fatal("a terminal read the chain")
	}
}

func TestAppRequestsAndUnnamedTerminalsMakeNoLink(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.chain = OpenChain(env.dataDir)
	m.recordChain(Party{App: true, FirstName: "MoltenTerm", BlockId: "x"}, Party{FirstName: "Jérôme", BlockId: "blockB"})
	m.recordChain(Party{BlockId: "blockShell"}, Party{FirstName: "Jérôme", BlockId: "blockB"})
	m.recordChain(Party{FirstName: "Camille", BlockId: "blockA"}, Party{BlockId: "blockShell"})
	if got := m.chain.Edges(); len(got) != 0 {
		t.Fatalf("links from requests that are no delegation: %+v", got)
	}
}
