// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/termupdate"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Update terminal (FR-SHELL-041, DS-SHELL-056): a terminal's shell is replaced by a fresh one in the same pane, the
// way Restart Session does it, but from wavesrv, in a given folder, and also for a terminal no window shows yet.
// termupdate decides when (never while a program runs); this file only does it.

const replaceSettle = 100 * time.Millisecond

func init() {
	termupdate.UseShell(termupdate.Shell{Replace: replaceTerminalShell, SendInput: typeIntoTerminal})
	mission.UseStarter(termupdate.Start)
}

func typeIntoTerminal(blockId string, data []byte) error {
	return SendInput(blockId, &BlockInputUnion{InputData: data})
}

// replaceTerminalShell ends the block's shell job and starts a new one in cwd. The block keeps its id, its place and
// its term file, so the scrollback stays, followed by the notice.
func replaceTerminalShell(ctx context.Context, blockId string, cwd string, notice string) error {
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return fmt.Errorf("reading the terminal: %w", err)
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return fmt.Errorf("finding the terminal's tab: %w", err)
	}
	termSize := waveobj.TermSize{}
	if block.JobId != "" {
		if job, err := wstore.DBGet[*waveobj.Job](ctx, block.JobId); err == nil && job != nil {
			termSize = job.CmdTermSize
		}
	}
	if cwd != "" && cwd != block.Meta.GetString(waveobj.MetaKey_CmdCwd, "") {
		oref := waveobj.MakeORef(waveobj.OType_Block, blockId)
		if err := wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: cwd}, false); err != nil {
			return fmt.Errorf("setting the terminal's folder: %w", err)
		}
		publishBlockUpdate(ctx, oref)
	}
	// A terminal of a tab no window opened yet has no controller, but its job may run (reconnected at startup); a
	// durable controller ends its job itself.
	if getController(blockId) == nil {
		if block.JobId != "" {
			jobcontroller.TerminateAndDetachJob(ctx, block.JobId)
		}
	} else {
		DestroyBlockController(blockId)
	}
	time.Sleep(replaceSettle)
	line := "\r\n\x1b[90m[" + notice + "]\x1b[0m\r\n"
	if err := filestore.WFS.AppendData(ctx, blockId, wavebase.BlockFile_Term, []byte(line)); err != nil {
		return fmt.Errorf("writing to the terminal: %w", err)
	}
	var rtOpts *waveobj.RuntimeOpts
	if termSize.Rows > 0 && termSize.Cols > 0 {
		rtOpts = &waveobj.RuntimeOpts{TermSize: termSize}
	}
	return ResyncController(ctx, tabId, blockId, rtOpts, true)
}

// The same update event as wcore.SendWaveObjUpdate, which this package cannot import.
func publishBlockUpdate(ctx context.Context, oref waveobj.ORef) {
	obj, err := wstore.DBGetORef(ctx, oref)
	if err != nil || obj == nil {
		return
	}
	wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_WaveObjUpdate,
		Scopes: []string{oref.String()},
		Data: waveobj.WaveObjUpdate{
			UpdateType: waveobj.UpdateType_Update,
			OType:      obj.GetOType(),
			OID:        waveobj.GetOID(obj),
			Obj:        obj,
		},
	})
}
