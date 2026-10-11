// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package spawns counts the programs MoltenTerm's own background work starts (git, gh, the agents' usage readers),
// so the performance harness can tell how many a minute an idle app runs (FR-PERF-011, NFR-PERF-001). Terminals and
// the jobs users start are not counted: they are the user's work, not MoltenTerm's.
package spawns

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Stats struct {
	// Since is when the counting started (wavesrv's start), in Unix milliseconds.
	Since  int64            `json:"since"`
	At     int64            `json:"at"`
	Total  int64            `json:"total"`
	Counts map[string]int64 `json:"counts"`
}

var lock sync.Mutex
var counts = map[string]int64{}
var since = time.Now()

func programName(name string) string {
	base := strings.ToLower(filepath.Base(name))
	return strings.TrimSuffix(base, ".exe")
}

// Count records one start of the program (a path or a bare name).
func Count(name string) {
	key := programName(name)
	lock.Lock()
	defer lock.Unlock()
	counts[key]++
}

// Command is exec.CommandContext, counted.
func Command(ctx context.Context, name string, args ...string) *exec.Cmd {
	Count(name)
	return exec.CommandContext(ctx, name, args...)
}

func Snapshot() Stats {
	lock.Lock()
	defer lock.Unlock()
	rtn := Stats{Since: since.UnixMilli(), At: time.Now().UnixMilli(), Counts: make(map[string]int64, len(counts))}
	for name, n := range counts {
		rtn.Counts[name] = n
		rtn.Total += n
	}
	return rtn
}

// Reset clears the counts (tests).
func Reset() {
	lock.Lock()
	defer lock.Unlock()
	counts = map[string]int64{}
	since = time.Now()
}
