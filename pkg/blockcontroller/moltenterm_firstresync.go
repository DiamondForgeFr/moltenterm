// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"log"

	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/util/ds"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// A terminal must have a live shell when it is shown after a relaunch (FR-PERF-005). Wave starts a durable shell
// without force, so a block whose session ended (job manager gone after a reboot, a crash, or a shell that exited)
// stays without a shell until the user presses Enter. That is right during a run, where it keeps a shell the user
// exited closed, but not at the first resync of a block in a run: a non-durable terminal starts a new shell there,
// so a durable one does too. A session that is still running is reattached as before (#156).

const endedSessionNotice = "\r\n\x1b[90m[MoltenTerm: the previous session of this terminal ended; a new shell starts]\x1b[0m\r\n"

// Blocks whose controller this run already started or found running.
var resyncedBlocks = ds.MakeSyncMap[bool]()

func isFirstResync(blockId string) bool {
	_, seen := resyncedBlocks.GetEx(blockId)
	return !seen
}

// markResynced is called only once the controller runs or started without error, so a start that failed (a remote
// connection not up yet) is retried as a first resync.
func markResynced(blockId string) {
	resyncedBlocks.Set(blockId, true)
}

type durableStarter struct {
	start func(force bool) error
	// the controller's status after a start
	status func() string
	// the job manager status of the job the block records, "" when it records none
	jobStatus func() string
	notice    func()
}

func startDurableAtFirstResync(s durableStarter) error {
	jobStatus := s.jobStatus()
	if jobStatus != "" && jobStatus != jobcontroller.JobManagerStatus_Running {
		s.notice()
		return s.start(true)
	}
	err := s.start(false)
	if err == nil || s.status() != Status_Done {
		return err
	}
	// The job was recorded as running but its manager was gone: the failed reconnect marked it done.
	s.notice()
	return s.start(true)
}

func startBlockController(ctx context.Context, controller Controller, blockData *waveobj.Block, rtOpts *waveobj.RuntimeOpts, force bool, durable bool) error {
	blockId := blockData.OID
	if force || !durable || !isFirstResync(blockId) {
		return controller.Start(ctx, blockData.Meta, rtOpts, force)
	}
	return startDurableAtFirstResync(durableStarter{
		start: func(force bool) error {
			return controller.Start(ctx, blockData.Meta, rtOpts, force)
		},
		status: func() string {
			return controller.GetRuntimeStatus().ShellProcStatus
		},
		jobStatus: func() string {
			if blockData.JobId == "" {
				return ""
			}
			status, err := jobcontroller.GetJobManagerStatus(ctx, blockData.JobId)
			if err != nil {
				// unknown: Start reads it again and reports the error
				return jobcontroller.JobManagerStatus_Running
			}
			return status
		},
		notice: func() {
			log.Printf("block %q: session %s ended, starting a new durable shell at the first resync\n", blockId, blockData.JobId)
			if err := HandleAppendBlockFile(blockId, wavebase.BlockFile_Term, []byte(endedSessionNotice)); err != nil {
				log.Printf("block %q: ended session notice not written: %v\n", blockId, err)
			}
		},
	})
}
