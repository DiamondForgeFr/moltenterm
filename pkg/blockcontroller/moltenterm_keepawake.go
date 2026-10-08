// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/keepawake"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// The keep-awake and the sleep policy (FR-SHELL-023, pkg/molten/keepawake) start with Mission Control, like the
// durable sessions: they read which cmd blocks run (this package's controllers) and Mission Control's running work.

// Mission Control's running work is read from its run records on disk: the keep-awake asks at most this often.
const missionWorkCacheTtl = 10 * time.Second

func init() {
	cache := &missionWorkCache{}
	mission.UseStarter(func() {
		keepawake.Start(keepawake.Hooks{
			CommandBlocks:     runningCommandBlocks,
			ShellRunning:      shellRunning,
			MissionWorkspaces: cache.workspaces,
		})
	})
}

// runningCommandBlocks lists the cmd blocks whose command runs now: their command is the block's foreground command.
func runningCommandBlocks() []string {
	var rtn []string
	for blockId, controller := range getAllControllers() {
		controllerType := ""
		switch c := controller.(type) {
		case *ShellController:
			controllerType = c.ControllerType
		case *DurableShellController:
			controllerType = c.ControllerType
		}
		if controllerType != BlockController_Cmd {
			continue
		}
		if status := controller.GetRuntimeStatus(); status.ShellProcStatus == Status_Running {
			rtn = append(rtn, blockId)
		}
	}
	return rtn
}

// shellRunning tells whether a terminal's shell still runs. A terminal no window opened yet has no controller while its
// durable job may run (reconnected at startup): it is taken as running, its marks decide.
func shellRunning(blockId string) bool {
	controller := getController(blockId)
	if controller == nil {
		return true
	}
	return controller.GetRuntimeStatus().ShellProcStatus == Status_Running
}

type missionWorkCache struct {
	lock sync.Mutex
	at   time.Time
	ids  []string
}

func (c *missionWorkCache) workspaces(ctx context.Context) []string {
	c.lock.Lock()
	defer c.lock.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < missionWorkCacheTtl {
		return c.ids
	}
	var ids []string
	for _, item := range mission.CurrentWork(ctx) {
		ids = append(ids, item.WorkspaceId)
	}
	c.ids, c.at = ids, time.Now()
	return ids
}
