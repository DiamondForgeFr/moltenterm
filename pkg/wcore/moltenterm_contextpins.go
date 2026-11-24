// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/contextpins"
	"github.com/wavetermdev/waveterm/pkg/molten/contexts"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The views pinned in the top row of the sidebar belong to a context (FR-SHELL-080, #2526): the client meta holds one
// row per context (pkg/molten/contextpins), and a workspace reads the row of the context it is in.

const contextPinsStartupTimeout = 30 * time.Second

func contextIdsOf(list []contexts.Context) []string {
	ids := make([]string, len(list))
	for i, c := range list {
		ids[i] = c.Id
	}
	return ids
}

// pinsOfWorkspaceMeta is the row of the context a workspace is in, as the client meta stores it.
func pinsOfWorkspaceMeta(clientMeta waveobj.MetaMapType, workspaceMeta waveobj.MetaMapType) []any {
	list := contexts.ReadContexts(clientMeta)
	return contextpins.PinsOf(clientMeta, contexts.ContextOf(list, workspaceMeta))
}

// pinsOfWorkspace is the row of the context a workspace is in; nil when the workspace or the client cannot be read.
func pinsOfWorkspace(ctx context.Context, workspaceId string) []any {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil || client == nil {
		return nil
	}
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId)
	if err != nil || ws == nil {
		return nil
	}
	return pinsOfWorkspaceMeta(client.Meta, ws.Meta)
}

// pinIds lists the ids of the pins of a row.
func pinIds(pins []any) []string {
	var rtn []string
	for _, p := range pins {
		if pin, _ := p.(map[string]any); pin != nil {
			if id, _ := pin["id"].(string); id != "" {
				rtn = append(rtn, id)
			}
		}
	}
	return rtn
}

// pinOfRow is the pin of a row with this id; nil when the row holds none.
func pinOfRow(pins []any, id string) map[string]any {
	for _, p := range pins {
		if pin, _ := p.(map[string]any); pin != nil {
			if pinId, _ := pin["id"].(string); pinId == id {
				return pin
			}
		}
	}
	return nil
}

// MigrateContextPins copies the one top row an earlier version kept for the whole client into every existing context,
// once (#2526): the client is marked in the same transaction, so a later start copies nothing and a context made after
// it starts from the row of the context the window came from (frontend/moltenterm-shell/sidebar/context-pins-model.ts).
func MigrateContextPins(ctx context.Context) error {
	return withContextsLock(func() error {
		return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
			tctx := tx.Context()
			client, err := wstore.DBGetSingleton[*waveobj.Client](tctx)
			if err != nil {
				return fmt.Errorf("reading the client: %w", err)
			}
			if client == nil {
				return nil
			}
			patch := contextpins.Migration(client.Meta, contextIdsOf(contexts.ReadContexts(client.Meta)))
			if patch == nil {
				return nil
			}
			client.Meta = waveobj.MergeMeta(client.Meta, patch, false)
			return wstore.DBUpdate(tctx, client)
		})
	})
}

// StartContextPins copies the former top row into the contexts before any window shows a workspace; wavesrv calls it
// once. A failure leaves the former row in place and the migration runs again at the next start.
func StartContextPins() {
	defer func() {
		panichandler.PanicHandler("StartContextPins", recover())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), contextPinsStartupTimeout)
	defer cancel()
	if err := MigrateContextPins(ctx); err != nil {
		log.Printf("molten: giving the contexts their top row: %v\n", err)
	}
}
