// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package proctree

import (
	"os"
	"path/filepath"
)

func readProcs() ([]Proc, error) {
	statData, err := os.ReadFile("/proc/stat")
	if err != nil {
		return nil, err
	}
	bootSec := parseBootTime(statData)
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	list := make([]Proc, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if name == "" || name[0] < '0' || name[0] > '9' {
			continue
		}
		// A process may end between the listing and the read: it is simply not in the table.
		data, err := os.ReadFile(filepath.Join("/proc", name, "stat"))
		if err != nil {
			continue
		}
		if p, ok := parseStat(data, bootSec); ok {
			list = append(list, p)
		}
	}
	return list, nil
}
