// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package telemetry

import "testing"

// Morphterm never uploads usage telemetry (FR-FORK-003).
func TestTelemetryIsAlwaysDisabled(t *testing.T) {
	if IsTelemetryEnabled() {
		t.Fatalf("IsTelemetryEnabled must always report false")
	}
}
