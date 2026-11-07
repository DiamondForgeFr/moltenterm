// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wavebase

import (
	"fmt"
	"os/exec"
)

// GetNodeRunnerPath returns the program that runs the Node.js scripts of an app build (Tailwind CSS for tsunami apps).
//
// A dev run hands wavesrv its Electron binary (WAVETERM_ELECTRONEXECPATH), which runs scripts as Node with
// ELECTRON_RUN_AS_NODE=1. A packaged app hands nothing: its runAsNode fuse is off (#1975, FR-BRW-014), so that variable
// would start the app again instead of the script. Node.js is then the one on the PATH, like the Go toolchain the same
// build needs.
func GetNodeRunnerPath() (string, error) {
	return pickNodeRunner(GetWaveAppElectronExecPath(), exec.LookPath)
}

func pickNodeRunner(electronExecPath string, lookPath func(string) (string, error)) (string, error) {
	if electronExecPath != "" {
		return electronExecPath, nil
	}
	nodePath, err := lookPath("node")
	if err != nil {
		return "", fmt.Errorf("Node.js was not found on the PATH: building an app needs it to generate the app's CSS")
	}
	return nodePath, nil
}
