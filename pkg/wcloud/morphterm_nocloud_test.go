// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcloud

import (
	"context"
	"os"
	"testing"
)

// Morphterm never contacts Wave's cloud (FR-FORK-003): the endpoints stay empty
// even when the historical environment variables point somewhere.
func TestNoWaveCloudEndpoints(t *testing.T) {
	t.Setenv(WCloudEndpointVarName, "https://api.example.invalid/central")
	t.Setenv(WCloudPingEndpointVarName, "https://ping.example.invalid/central")

	if err := CacheAndRemoveEnvVars(); err != nil {
		t.Fatalf("CacheAndRemoveEnvVars must accept any environment, got: %v", err)
	}
	if _, found := os.LookupEnv(WCloudEndpointVarName); found {
		t.Fatalf("%s must be removed from the environment", WCloudEndpointVarName)
	}
	if got := GetEndpoint(); got != "" {
		t.Fatalf("GetEndpoint must be empty, got %q", got)
	}
	if got := GetPingEndpoint(); got != "" {
		t.Fatalf("GetPingEndpoint must be empty, got %q", got)
	}
	if _, err := makeAnonPostReq(context.Background(), TEventsUrl, nil); err == nil {
		t.Fatalf("no telemetry request may be built")
	}
	if _, err := makePingPostReq(context.Background(), PingUrl, nil); err == nil {
		t.Fatalf("no ping request may be built")
	}
	if err := SendDiagnosticPing(context.Background(), "test-client", false); err != nil {
		t.Fatalf("the diagnostic ping must be a silent no-op, got: %v", err)
	}
}
