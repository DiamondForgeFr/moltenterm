// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"sync"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Other parts of wavesrv follow the shell integration's marks too (FR-SHELL-041: the generation a shell's refresh
// hook reports, the first prompt of a replaced shell). Observers run on the output path: they must not block.

type ShellMarkObserver func(blockId string, mark ShellMark)

var shellMarkObserversLock sync.Mutex
var shellMarkObservers []ShellMarkObserver

// OnShellMark registers an observer of every shell integration mark wavesrv reads in a terminal's output.
func OnShellMark(observer ShellMarkObserver) {
	shellMarkObserversLock.Lock()
	defer shellMarkObserversLock.Unlock()
	shellMarkObservers = append(shellMarkObservers, observer)
}

func getShellMarkObservers() []ShellMarkObserver {
	shellMarkObserversLock.Lock()
	defer shellMarkObserversLock.Unlock()
	return append([]ShellMarkObserver(nil), shellMarkObservers...)
}

func notifyShellMark(blockId string, mark ShellMark) {
	defer func() {
		panichandler.PanicHandler("molten:shellmark", recover())
	}()
	for _, observer := range getShellMarkObservers() {
		observer(blockId, mark)
	}
}

// LocateShell finds a terminal's local process (its shell, or a block's command), as the agent states do.
func LocateShell(blockId string) (ShellProcess, bool) {
	locator := getShellLocator()
	if locator.Locate == nil {
		return ShellProcess{}, false
	}
	return locator.Locate(blockId)
}

// ReadProcessArgs reads a process's executable and arguments (agent detection by process, FR-SHELL-011).
func ReadProcessArgs(pid int32) (string, []string) {
	return readProcessArgs(pid)
}
