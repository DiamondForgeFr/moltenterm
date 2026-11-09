// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// goRecovered runs fn in a goroutine that recovers its panic: a panic left to run kills wavesrv, and the app with it
// (#2125). The shared helper for the whole of pkg/molten is #2128.
func goRecovered(name string, fn func()) {
	go func() {
		defer func() {
			panichandler.PanicHandler(name, recover())
		}()
		fn()
	}()
}
