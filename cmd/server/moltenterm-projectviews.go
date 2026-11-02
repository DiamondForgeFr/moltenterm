// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wcore"
)

const projectViewsStartupTimeout = 30 * time.Second

// assignProjectViewsAtStartup gives the views of the workspaces with several projects their projects before any window
// shows one (#1760). It writes workspace meta only; a failure leaves the views shared by every project, as before.
func assignProjectViewsAtStartup() {
	defer func() {
		panichandler.PanicHandler("assignProjectViewsAtStartup", recover())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), projectViewsStartupTimeout)
	defer cancel()
	if err := wcore.AssignProjectViewsAtStartup(ctx); err != nil {
		log.Printf("molten: giving the views their projects: %v\n", err)
	}
}
