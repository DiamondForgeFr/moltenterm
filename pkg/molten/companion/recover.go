// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// everyRecovered runs step every interval (at once first when now is set) until stop closes; nil never closes. A
// panic ends that pass only: recovered outside the loop, one bad reading would end it for the rest of the run (#2125).
func everyRecovered(name string, every time.Duration, now bool, stop <-chan struct{}, step func()) {
	defer func() {
		panichandler.PanicHandler(name, recover())
	}()
	if now {
		passRecovered(name, step)
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			passRecovered(name, step)
		}
	}
}

func passRecovered(name string, step func()) {
	defer func() {
		panichandler.PanicHandler(name, recover())
	}()
	step()
}
