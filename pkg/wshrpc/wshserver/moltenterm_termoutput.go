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

// moltenCheckTermOutputRead: a terminal reads the output of its own workspace's blocks only (NFR-FORK-001, #1832).
func moltenCheckTermOutputRead(ctx context.Context, blockId string) error {
	caller := moltenMetaCaller(ctx, true)
	if caller.Trusted {
		return nil
	}
	return metaguard.CheckTermOutputRead(caller, blockId, moltenInWorkspace(ctx, caller, waveobj.MakeORef(waveobj.OType_Block, blockId)))
}

// moltenCheckZoneRead: a terminal streams the wave files of its own workspace's blocks, or of the durable sessions
// attached to them (a job's zone), and no other zone.
func moltenCheckZoneRead(ctx context.Context, zoneId string) error {
	caller := moltenMetaCaller(ctx, true)
	if caller.Trusted {
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

// moltenForwardGuard checks the requests the root router forwards to a panel's frontend client with a terminal's
// output (metaguard.TermOutputCommands): the window answers whoever asks, so the caller is checked before it does.
func moltenForwardGuard(router *wshutil.WshRouter, msg wshutil.RpcMessage, ingressLinkId baseds.LinkId) error {
	if !metaguard.TermOutputCommands[msg.Command] {
		return nil
	}
	caller := metaguard.CallerOf(router, msg.Source, ingressLinkId)
	if caller.Trusted {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), moltenForwardLookupTimeout)
	defer cancel()
	if caller.BlockId != "" {
		caller.WorkspaceId = moltenWorkspaceOf(ctx, waveobj.MakeORef(waveobj.OType_Block, caller.BlockId))
	}
	return metaguard.CheckForwardedRead(caller, msg.Command, msg.Route, func(blockId string) bool {
		return moltenInWorkspace(ctx, caller, waveobj.MakeORef(waveobj.OType_Block, blockId))
	})
}
