// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

func TestNotMoltenTerminalError(t *testing.T) {
	t.Setenv(wshutil.WaveJwtTokenVarName, "")
	checks := map[string]error{
		"preRunSetupRpcClient":     preRunSetupRpcClient(nil, nil),
		"preRunSetupHookRpcClient": preRunSetupHookRpcClient(nil, nil),
		"preRunCheckJwt":           preRunCheckJwt(nil, nil),
	}
	for name, err := range checks {
		if err == nil {
			t.Fatalf("%s: no error without a token", name)
		}
		msg := err.Error()
		if !strings.Contains(msg, "MoltenTerm terminal") {
			t.Errorf("%s: %q does not say the terminal is not a MoltenTerm terminal", name, msg)
		}
		for _, word := range []string{"Wave", "SSH", "WAVETERM"} {
			if strings.Contains(msg, word) {
				t.Errorf("%s: %q names %s", name, msg, word)
			}
		}
	}
}
