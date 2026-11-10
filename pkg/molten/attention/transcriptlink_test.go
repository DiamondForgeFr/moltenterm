// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
)

// #2142: a hook's report hands its main session's transcript to the companion only from the block's own local
// terminal, like the companion's own report command. Serial: it sets the package's hand-off.
func TestLinkTranscriptOnlyFromTheBlocksOwnTerminal(t *testing.T) {
	var got []string
	SetTranscriptLink(func(blockId string, agent string, path string) {
		got = append(got, blockId+"|"+agent+"|"+path)
	})
	t.Cleanup(func() { SetTranscriptLink(nil) })
	own := localroute.Caller{IsLocalTerminal: true, BlockId: "b1"}
	req := molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWorking, Agent: "claude", Transcript: "/h/s.jsonl"}
	linkTranscript(own, req)
	if len(got) != 1 || got[0] != "b1|claude|/h/s.jsonl" {
		t.Fatalf("own terminal: %v", got)
	}
	for name, c := range map[string]struct {
		caller localroute.Caller
		edit   func(r *molten.AgentStateRequest)
	}{
		"another terminal":      {localroute.Caller{IsLocalTerminal: true, BlockId: "b2"}, nil},
		"a token without block": {localroute.Caller{IsLocalTerminal: true}, nil},
		"a window":              {localroute.Caller{IsWindow: true}, nil},
		"a remote terminal":     {localroute.Caller{BlockId: "b1"}, nil},
		"a sub-agent":           {own, func(r *molten.AgentStateRequest) { r.Subagent = "a1" }},
		"a turn end":            {own, func(r *molten.AgentStateRequest) { r.TurnEnd = true }},
		"no transcript":         {own, func(r *molten.AgentStateRequest) { r.Transcript = "" }},
	} {
		got = nil
		r := req
		if c.edit != nil {
			c.edit(&r)
		}
		linkTranscript(c.caller, r)
		if len(got) != 0 {
			t.Errorf("%s: handed over %v", name, got)
		}
	}
}
