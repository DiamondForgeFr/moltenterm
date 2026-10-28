// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// NFR-SHELL-012: the hand-off runs alongside the status line command, never before it, so it adds nothing to the
// status line. No duration is measured (#1208): with the hand-off's limit out of reach, this hand-off only returns once
// the command ran, so a relay that handed off first waits for it until the test's deadline.
func TestStatusLineRelayHandsOffAlongsideTheCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell")
	}
	saved := relaySendTimeout
	relaySendTimeout = time.Hour
	t.Cleanup(func() { relaySendTimeout = saved })
	marker := filepath.Join(t.TempDir(), "ran")
	sawCommand := make(chan bool, 1)
	send := func(AgentStatusLineRequest) {
		deadline := time.Now().Add(time.Minute)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(marker); err == nil {
				sawCommand <- true
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		sawCommand <- false
	}
	var stdout, stderr bytes.Buffer
	input := `{"session_id":"s1","model":{"display_name":"Opus"}}`
	code := RunStatusLineRelay(strings.NewReader(input), &stdout, &stderr, []string{"touch '" + marker + "'; echo hi"}, send)
	if code != 0 || stdout.String() != "hi\n" {
		t.Errorf("exit %d, output %q", code, stdout.String())
	}
	if !<-sawCommand {
		t.Error("the hand-off ran before the status line command")
	}
}
