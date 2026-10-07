// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package agentcontinuity

import (
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestReadBoundedFileRefusesFifo(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "models_cache.json")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Skip(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := readBoundedFile(fifo, maxCodexFileBytes)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Error("a FIFO was read")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("reading a FIFO blocked")
	}
}
