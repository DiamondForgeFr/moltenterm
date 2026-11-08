// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"context"
	"log"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The developer's notes on agents (FR-SHELL-084, #2008) belong to the agent's terminal: they go when the terminal
// closes. The window writes them, in the workspace's meta (molten.AgentNotesMetaKey), by "<block id>" for an agent and
// "<block id>/<sub-agent id>" for one of its sub-agents.

const agentNoteSubSeparator = "/"

// agentNotesWithout is the notes map without the entries of blockId's terminal and its sub-agents, and whether any was
// there. A value of another shape is not a notes map and is left as it is.
func agentNotesWithout(raw any, blockId string) (map[string]any, bool) {
	notes, ok := raw.(map[string]any)
	if !ok || blockId == "" {
		return nil, false
	}
	kept := make(map[string]any, len(notes))
	dropped := false
	for key, value := range notes {
		if key == blockId || strings.HasPrefix(key, blockId+agentNoteSubSeparator) {
			dropped = true
			continue
		}
		kept[key] = value
	}
	return kept, dropped
}

// dropAgentNotes removes the notes of a closed terminal from the workspace that holds them. The block is gone when its
// close is told, so the workspace is found by looking for the notes themselves.
func dropAgentNotes(blockId string) {
	defer func() {
		panichandler.PanicHandler("molten:dropAgentNotes", recover())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), agentNamesTimeout)
	defer cancel()
	workspaces, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		log.Printf("molten: reading the workspaces for the notes of closed agent %s: %v\n", blockId, err)
		return
	}
	for _, workspace := range workspaces {
		kept, dropped := agentNotesWithout(workspace.Meta[molten.AgentNotesMetaKey], blockId)
		if !dropped {
			continue
		}
		// nil removes the key, as an empty notes map would leave it behind.
		update := waveobj.MetaMapType{molten.AgentNotesMetaKey: nil}
		if len(kept) > 0 {
			update[molten.AgentNotesMetaKey] = kept
		}
		oref := waveobj.MakeORef(waveobj.OType_Workspace, workspace.OID)
		if err := wstore.UpdateObjectMeta(ctx, oref, update, false); err != nil {
			log.Printf("molten: dropping the notes of closed agent %s: %v\n", blockId, err)
			continue
		}
		publishObjectUpdate(ctx, oref)
	}
}
