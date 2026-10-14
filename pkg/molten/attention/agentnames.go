// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"context"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Agent first names (FR-CONT-014, DS-CONT-028): each block with an agent record holds a name from the allocator
// (pkg/molten/agentnames) for as long as the record lives. The block's last name is kept in its meta, wavesrv's store
// and never the project's files, so a durable terminal's agent that outlives a restart gets it back when it is free.

const agentNamesTimeout = 5 * time.Second

// rememberAgentName writes the block's current name in its meta. It reads the name again rather than taking it as an
// argument: two runs named in a row then never leave the older name behind.
func rememberAgentName(a *agentStates, blockId string) {
	defer func() {
		panichandler.PanicHandler("molten:rememberAgentName", recover())
	}()
	name := a.names.Held(blockId)
	if name == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), agentNamesTimeout)
	defer cancel()
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId)
	if err := wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{molten.AgentFirstNameMetaKey: name}, false); err != nil {
		return
	}
	publishObjectUpdate(ctx, oref)
}

// loadAgentNames offers each terminal its last name before any agent is seen in it.
func loadAgentNames(a *agentStates) {
	ctx, cancel := context.WithTimeout(context.Background(), agentNamesTimeout)
	defer cancel()
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		log.Printf("molten: reading the agents' first names: %v\n", err)
		return
	}
	for _, block := range blocks {
		if name := block.Meta.GetString(molten.AgentFirstNameMetaKey, ""); name != "" {
			a.names.Prefer(block.OID, name)
		}
	}
}

// AgentRunByFirstName finds the active agent holding a first name, case-insensitively (handing work to an agent by
// name, #595).
func AgentRunByFirstName(name string) (molten.AgentRunInfo, bool) {
	blockId, ok := defaultAgentStates.names.Owner(name)
	if !ok {
		return molten.AgentRunInfo{}, false
	}
	return defaultAgentStates.runOf(blockId)
}
