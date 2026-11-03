// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// moltenForwardLookupTimeout bounds the workspace lookups the router's loop does for a forwarded read.
const moltenForwardLookupTimeout = 2 * time.Second

func init() {
	wshutil.SetRequestGuard(moltenForwardGuard)
}

// moltenCheckTermOutputRead: a local terminal reads the output of its own workspace's blocks only (NFR-FORK-001,
// #1832). A remote host is unchanged here: the remote-host guard (#1831) owns it.
func moltenCheckTermOutputRead(ctx context.Context, blockId string) error {
	caller := moltenMetaCaller(ctx, true)
	if caller.Trusted || !caller.Local {
		return nil
	}
	return metaguard.CheckTermOutputRead(caller, blockId, moltenInWorkspace(ctx, caller, waveobj.MakeORef(waveobj.OType_Block, blockId)))
}

// moltenCheckZoneRead: a terminal streams the wave files of its own workspace's blocks, or of the durable sessions
// attached to them (a job's zone), and no other zone.
func moltenCheckZoneRead(ctx context.Context, zoneId string) error {
	caller := moltenMetaCaller(ctx, true)
	if caller.Trusted || !caller.Local {
		return nil
	}
	blockId := zoneId
	if job, err := wstore.DBGet[*waveobj.Job](ctx, zoneId); err == nil && job != nil {
		blockId = job.AttachedBlockId
		if blockId == "" {
			return fmt.Errorf("refused: a terminal cannot read the files of session %s, attached to no block; the MoltenTerm window does", zoneId)
		}
	}
	return metaguard.CheckTermOutputRead(caller, blockId, moltenInWorkspace(ctx, caller, waveobj.MakeORef(waveobj.OType_Block, blockId)))
}

func moltenCheckBlockFileSubscribe(ctx context.Context, req wps.SubscriptionRequest) error {
	caller := moltenMetaCaller(ctx, true)
	return metaguard.CheckBlockFileSubscribe(caller, req, func(oref waveobj.ORef) bool { return moltenInWorkspace(ctx, caller, oref) })
}

// moltenForwardGuard checks the requests the root router forwards to the window's frontend clients that read or act
// on the panes (metaguard.ForwardedCommands): the window answers whoever asks, so the caller is checked before it does.
func moltenForwardGuard(router *wshutil.WshRouter, msg wshutil.RpcMessage, ingressLinkId baseds.LinkId) error {
	if _, checked := metaguard.ForwardedCommands[msg.Command]; !checked {
		return nil
	}
	caller := metaguard.CallerOf(router, msg.Source, ingressLinkId)
	if caller.Trusted || !caller.Local {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), moltenForwardLookupTimeout)
	defer cancel()
	if caller.BlockId != "" {
		caller.WorkspaceId = moltenWorkspaceOf(ctx, waveobj.MakeORef(waveobj.OType_Block, caller.BlockId))
	}
	var blockId string
	if data, ok := msg.Data.(map[string]any); ok {
		blockId, _ = data["blockid"].(string)
	}
	return metaguard.CheckForwardedRequest(caller, msg.Command, msg.Route, blockId, func(oref waveobj.ORef) bool {
		return moltenInWorkspace(ctx, caller, oref)
	})
}
