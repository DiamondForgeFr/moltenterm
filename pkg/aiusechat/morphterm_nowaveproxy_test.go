// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// A "wave" mode never gets Wave's cloud proxy as its endpoint (FR-FORK-003).
func TestWaveModeHasNoDefaultEndpoint(t *testing.T) {
	t.Setenv(uctypes.WaveAIEndpointEnvName, "")
	config := wconfig.AIModeConfigType{
		Provider: uctypes.AIProvider_Wave,
	}
	applyProviderDefaults(&config)
	if config.Endpoint != "" {
		t.Fatalf("a wave mode must not get a default endpoint, got %q", config.Endpoint)
	}
	if !config.WaveAICloud {
		t.Fatalf("a wave mode must stay flagged as a cloud mode, so the chat refuses it")
	}
}
