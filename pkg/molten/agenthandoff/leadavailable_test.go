// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func setRun(env *fakeEnv, blockId string, state string, subagents int) {
	env.lock.Lock()
	defer env.lock.Unlock()
	r := env.runs[blockId]
	r.State, r.Subagents = state, subagents
	env.runs[blockId] = r
}

// #2536: MoltenTerm's own requests (the page comments of the web page panel, a resume from the Integration panel) reach
// a lead whose turn ended at once, whatever its sub-agents do; only its own turn or a permission prompt queues them.
func TestAppRequestReachesALeadWhoseSubagentsWork(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	setRun(env, "blockB", molten.AgentStateDone, 1)
	sent, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "The developer left 2 comments on a page."})
	if err != nil || sent.Status != StatusDelivered || len(env.typedLines()) != 1 {
		t.Fatalf("free prompt, a sub-agent at work: %+v %v %+v", sent, err, env.typedLines())
	}

	for _, busy := range []string{molten.AgentStateWorking, molten.AgentStateWaiting} {
		m, env, _, _ := makeFixture(t)
		setRun(env, "blockB", busy, 1)
		sent, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "Comments."})
		if err != nil || sent.Status != StatusQueued || len(env.typedLines()) != 0 {
			t.Fatalf("%s: %+v %v %+v", busy, sent, err, env.typedLines())
		}
		setRun(env, "blockB", molten.AgentStateDone, 1)
		waitFor(t, "the queued request once the prompt is free", func() bool { return len(env.typedLines()) == 1 })
	}
}
