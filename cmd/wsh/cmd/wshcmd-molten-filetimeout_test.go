// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

// #1831: on a server, `wsh file` waits long enough for the window's question (up to a minute) so the command
// completes after Allow; on this computer --timeout is kept.
func TestFileTimeoutCoversTheWindowsQuestion(t *testing.T) {
	if got := fileTimeoutFor(15000, ""); got != 15000 {
		t.Errorf("this computer: %d", got)
	}
	if got := fileTimeoutFor(15000, "local"); got != 15000 {
		t.Errorf("local: %d", got)
	}
	if got := fileTimeoutFor(15000, "dev@build.example"); got < 65000 {
		t.Errorf("a server waits %d ms, less than the question", got)
	}
	if got := fileTimeoutFor(300000, "dev@build.example"); got != 300000 {
		t.Errorf("a longer --timeout is kept: %d", got)
	}
}
