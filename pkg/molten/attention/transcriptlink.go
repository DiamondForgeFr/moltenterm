// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
)

// A hook's SessionStart links the pane to its transcript in the companion, which keeps the link in memory only: a
// wavesrv restart (an update) forgets it, and every reader of the pane's session then fell back to discovering it from
// the session folders, once a second (#2142). The hooks' working and done reports of the main session carry the
// transcript: they hand it to the companion, which links the pane when it has no link from its hook.

var transcriptLink = struct {
	lock sync.Mutex
	fn   func(blockId string, agent string, path string)
}{}

// SetTranscriptLink sets what a hook's report of its session's transcript is handed to; the companion sets it at start.
func SetTranscriptLink(fn func(blockId string, agent string, path string)) {
	transcriptLink.lock.Lock()
	defer transcriptLink.lock.Unlock()
	transcriptLink.fn = fn
}

func transcriptLinkFn() func(blockId string, agent string, path string) {
	transcriptLink.lock.Lock()
	defer transcriptLink.lock.Unlock()
	return transcriptLink.fn
}

// linkTranscript hands a main session's transcript over, only from the block's own local terminal: the companion's
// own report command (moltencompanionsession) accepts no other.
func linkTranscript(caller localroute.Caller, req molten.AgentStateRequest) {
	if req.Transcript == "" || req.Subagent != "" || req.TurnEnd || req.BlockId == "" {
		return
	}
	if !caller.IsLocalTerminal || caller.BlockId != req.BlockId {
		return
	}
	fn := transcriptLinkFn()
	if fn == nil {
		return
	}
	fn(req.BlockId, req.Agent, req.Transcript)
}
