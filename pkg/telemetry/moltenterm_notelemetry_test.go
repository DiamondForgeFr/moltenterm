// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package telemetry

import "testing"

// Moltenterm never uploads usage telemetry (FR-FORK-003).
func TestTelemetryIsAlwaysDisabled(t *testing.T) {
	if IsTelemetryEnabled() {
		t.Fatalf("IsTelemetryEnabled must always report false")
	}
}
