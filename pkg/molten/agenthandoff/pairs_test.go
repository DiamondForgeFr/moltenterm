// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// A pending request from a terminal without a name has no From: the menu words it (#1129).
func TestPendingFromAnUnnamedTerminal(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	seen := make(chan PairsResult, 1)
	env.lock.Lock()
	env.onNotify = func(input molten.NotificationInput) {
		if len(input.Actions) == 0 || input.Actions[0].Gesture != AnswerGesture {
			return
		}
		pairs, _ := m.Pairs(context.Background(), "tab:abc", PairsRequest{BlockId: "blockB"})
		seen <- pairs
		m.Answer("tab:abc", AnswerRequest{RequestId: input.Actions[0].Args["requestid"].(string), Decision: DecisionDismiss})
	}
	env.lock.Unlock()
	m.Send(context.Background(), SendRequest{Token: "tokShell", To: "Jérôme", Brief: Brief{Goal: "x"}})
	pairs := <-seen
	if len(pairs.Pending) != 1 || pairs.Pending[0].From != "" || pairs.Pending[0].To != "Jérôme" {
		t.Fatalf("pending: %+v", pairs.Pending)
	}
}

// The connections menu (#1050) sees the pending request, answers it like the notification, shows the pair's decision
// and forgets it, after which the next send asks again.
func TestPairsMenuAnswersShowsAndForgets(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	seen := make(chan PairsResult, 1)
	env.lock.Lock()
	env.onNotify = func(input molten.NotificationInput) {
		if len(input.Actions) == 0 || input.Actions[0].Gesture != AnswerGesture {
			return
		}
		pairs, err := m.Pairs(context.Background(), "tab:abc", PairsRequest{BlockId: "blockA"})
		if err != nil {
			t.Error(err)
		}
		seen <- pairs
		if len(pairs.Pending) == 1 {
			m.Answer("tab:abc", AnswerRequest{RequestId: pairs.Pending[0].RequestId, Decision: DecisionAlways})
		}
	}
	env.lock.Unlock()

	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "review the plan"}}); err != nil {
		t.Fatal(err)
	}
	pending := <-seen
	if len(pending.Pending) != 1 || pending.Pending[0].FromBlockId != "blockA" || pending.Pending[0].ToBlockId != "blockB" ||
		pending.Pending[0].Goal != "review the plan" || pending.Pending[0].From != "Camille" {
		t.Fatalf("pending: %+v", pending.Pending)
	}
	if err := m.Forget("tab:abc", ForgetRequest{BlockId: "blockA"}); uimsg.TextOf(err) == nil || uimsg.TextOf(err).Code != "handoff.forget.nopair" {
		t.Fatalf("forget without a pair: %v", err)
	}

	pairs, err := m.Pairs(context.Background(), "tab:abc", PairsRequest{BlockId: "blockA"})
	if err != nil {
		t.Fatal(err)
	}
	if len(pairs.Pending) != 0 || len(pairs.Agents) != 1 || pairs.Agents[0].FirstName != "Jérôme" || pairs.Agents[0].Decision != DecisionAlways {
		t.Fatalf("after Always: %+v", pairs)
	}
	asked := len(env.notifications())

	if err := m.Forget("proc:x", ForgetRequest{BlockId: "blockA", OtherBlockId: "blockB"}); err == nil {
		t.Fatal("a terminal forgot a pair")
	}
	if _, err := m.Pairs(context.Background(), "proc:x", PairsRequest{BlockId: "blockA"}); err == nil {
		t.Fatal("a terminal read the pairs")
	}
	if err := m.Forget("tab:abc", ForgetRequest{BlockId: "blockB", OtherBlockId: "blockA"}); err != nil {
		t.Fatal(err)
	}
	if pairs, _ := m.Pairs(context.Background(), "tab:abc", PairsRequest{BlockId: "blockA"}); pairs.Agents[0].Decision != "" {
		t.Fatalf("after Revoke: %+v", pairs.Agents)
	}
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "again"}}); err != nil {
		t.Fatal(err)
	}
	<-seen
	if len(env.notifications()) <= asked {
		t.Fatal("the send after Revoke did not ask the developer")
	}
}
