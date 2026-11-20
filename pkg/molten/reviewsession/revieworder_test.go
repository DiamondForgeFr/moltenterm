// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package reviewsession

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2431: a review's default is never an agent that cannot run one, whatever the registry's order says.
func TestReviewOrderKeepsOnlyAgentsThatRunAReview(t *testing.T) {
	got := reviewOrder([]string{molten.AgentIdKimi, molten.AgentIdCodex, molten.AgentIdClaude})
	if want := []string{molten.AgentIdCodex, molten.AgentIdClaude}; !reflect.DeepEqual(got, want) {
		t.Errorf("reviewOrder kept %v, want %v", got, want)
	}
	if got := reviewOrder([]string{molten.AgentIdKimi}); !reflect.DeepEqual(got, []string{molten.AgentIdClaude, molten.AgentIdCodex}) {
		t.Errorf("with no review agent in the order, the defaults apply: %v", got)
	}
	if isSupportedAgent(molten.AgentIdKimi) {
		t.Errorf("kimi cannot run a review")
	}
}
