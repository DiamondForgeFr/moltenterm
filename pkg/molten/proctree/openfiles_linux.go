// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package proctree

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const maxOpenFds = 4096

// OpenFiles lists the paths of the files a process holds open, or nil when they cannot be read (another user's
// process, an ended one). Only /proc's links are read, never the files.
func OpenFiles(pid int32) []string {
	if pid <= 0 {
		return nil
	}
	dir := filepath.Join("/proc", strconv.Itoa(int(pid)), "fd")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var rtn []string
	for i, e := range entries {
		if i >= maxOpenFds {
			break
		}
		target, err := os.Readlink(filepath.Join(dir, e.Name()))
		if err != nil || !strings.HasPrefix(target, "/") {
			continue
		}
		rtn = append(rtn, target)
	}
	return rtn
}
