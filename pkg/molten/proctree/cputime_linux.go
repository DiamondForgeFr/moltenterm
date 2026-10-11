// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package proctree

import (
	"os"
	"path/filepath"
	"strconv"
)

func readCpu(pid int32) (Cpu, bool) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(int(pid)), "stat"))
	if err != nil {
		return Cpu{}, false
	}
	return parseStatCpu(data)
}
