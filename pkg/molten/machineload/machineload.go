// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package machineload tells how loaded this computer is (#2502, FR-BOSS-009 AC85): the activity popover shows a
// discreet strip when the load makes the developer's tests and builds slower, so a slow run is not taken for a stuck
// one. The load is the 1-minute load average per logical CPU core: 1.0 is every core busy, 2.0 is a queue as long as
// the machine is wide.
package machineload

import (
	"runtime"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/load"
)

const (
	// Loaded starts at this load per core, and ends below LeavePerCore: a load that hovers around one number does not
	// make the strip blink.
	EnterPerCore = 2.0
	LeavePerCore = 1.25
	// A verdict older than this is not carried over: the machine was last looked at too long ago to say it is still
	// loaded, so the next reading starts from "not loaded" and the enter threshold applies.
	HoldFor = 60 * time.Second
)

// Reading is the machine's load at one look. Known is false where the system gives no load average.
type Reading struct {
	Known bool `json:"known"`
	// Load1 is the 1-minute load average, Cores the logical CPUs, PerCore their quotient.
	Load1   float64 `json:"load1,omitempty"`
	Cores   int     `json:"cores,omitempty"`
	PerCore float64 `json:"percore,omitempty"`
	// Loaded: the strip's verdict, with the hysteresis.
	Loaded bool `json:"loaded,omitempty"`
}

// Monitor keeps the hysteresis between looks.
type Monitor struct {
	lock   sync.Mutex
	loaded bool
	at     time.Time

	// Injected, replaced in tests.
	average func() (float64, error)
	cores   func() int
	now     func() time.Time
}

func MakeMonitor() *Monitor {
	return &Monitor{average: systemAverage, cores: runtime.NumCPU, now: time.Now}
}

// Default is wavesrv's monitor.
var Default = MakeMonitor()

func systemAverage() (float64, error) {
	stat, err := load.Avg()
	if err != nil {
		return 0, err
	}
	return stat.Load1, nil
}

// Next is the verdict after a reading of perCore load per core, given the previous one.
func Next(loaded bool, perCore float64) bool {
	if loaded {
		return perCore >= LeavePerCore
	}
	return perCore >= EnterPerCore
}

// Read looks at the machine now.
func (m *Monitor) Read() Reading {
	average, err := m.average()
	cores := m.cores()
	if err != nil || cores <= 0 || average < 0 {
		m.forget()
		return Reading{}
	}
	perCore := average / float64(cores)
	return Reading{Known: true, Load1: average, Cores: cores, PerCore: perCore, Loaded: m.judge(perCore)}
}

func (m *Monitor) judge(perCore float64) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	now := m.now()
	if !m.at.IsZero() && now.Sub(m.at) > HoldFor {
		m.loaded = false
	}
	m.loaded = Next(m.loaded, perCore)
	m.at = now
	return m.loaded
}

func (m *Monitor) forget() {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.loaded = false
	m.at = time.Time{}
}
