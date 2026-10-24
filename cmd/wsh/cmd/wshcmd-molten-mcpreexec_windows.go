// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package cmd

import (
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// Windows has no in-place re-execution: the server keeps its version and says once that a new one is on disk (#1049).
type moltenMcpReexec struct {
	name  string
	path  string
	size  int64
	mtime time.Time
	told  bool
}

func makeMoltenMcpReexec(name string, failed func() int) mcpbrowser.Reexec {
	path, err := os.Executable()
	if err != nil {
		return nil
	}
	fi, err := os.Stat(path)
	if err != nil {
		return nil
	}
	return &moltenMcpReexec{name: name, path: path, size: fi.Size(), mtime: fi.ModTime()}
}

func (r *moltenMcpReexec) Changed() bool {
	if r.told {
		return false
	}
	fi, err := os.Stat(r.path)
	return err == nil && (fi.Size() != r.size || !fi.ModTime().Equal(r.mtime))
}

func (r *moltenMcpReexec) Exec(state mcpbrowser.ResumeState, pending []byte) error {
	r.told = true
	err := errors.New("re-executing in place is not available on Windows")
	fmt.Fprintf(os.Stderr, "%s\n", moltenMcpKeptVersionMessage(r.name, err.Error()))
	return err
}
