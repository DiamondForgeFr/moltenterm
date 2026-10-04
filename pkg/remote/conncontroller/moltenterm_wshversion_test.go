// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package conncontroller

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// FR-REL-001: Moltenterm moves from Wave's 0.14.5 to its own 1.0.0-N. Wave's rule ("the remote wsh is up to date when it
// is the same version or newer", semver) is kept: a host holding Wave's 0.14.5 wsh must be updated, and numeric
// candidate numbers must compare as numbers (1.0.0-2 < 1.0.0-10).
func TestWshVersionAcrossMoltentermNumbering(t *testing.T) {
	saved := wavebase.WaveVersion
	defer func() { wavebase.WaveVersion = saved }()
	cases := []struct {
		app      string
		remote   string
		upToDate bool
	}{
		{"1.0.0-0", "wsh v0.14.5", false},
		{"1.0.0-0", "wsh v1.0.0-0", true},
		{"1.0.0-1", "wsh v1.0.0-0", false},
		{"1.0.0-1", "wsh v0.14.5", false},
		{"1.0.0-1", "wsh v1.0.0-1", true},
		{"1.0.0-1", "wsh v1.0.0-2", true},
		{"1.0.0-10", "wsh v1.0.0-2", false},
		{"1.0.0-2", "wsh v1.0.0-10", true},
		{"1.0.0", "wsh v1.0.0-3", false},
		{"1.0.0", "wsh v1.0.0", true},
		{"1.0.1-1", "wsh v1.0.0", false},
		{"1.0.0", "not-installed", false},
	}
	for _, c := range cases {
		wavebase.WaveVersion = c.app
		upToDate, _, _, err := IsWshVersionUpToDate(context.Background(), c.remote)
		if err != nil {
			t.Fatalf("%s against %q: %v", c.app, c.remote, err)
		}
		if upToDate != c.upToDate {
			t.Errorf("app %s, remote %q: up to date %v, want %v", c.app, c.remote, upToDate, c.upToDate)
		}
	}
}
