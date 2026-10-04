// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

func TestFormatMoltenVersion(t *testing.T) {
	got := formatMoltenVersion(moltenVersionInfo{Version: "1.0.0-0", WaveBase: "0.14.5", BuildTime: "202610041230"})
	if want := "MoltenTerm 1.0.0-0 (built 2026-10-04 12:30), based on Wave Terminal 0.14.5\n"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	got = formatMoltenVersion(moltenVersionInfo{Version: "0.0.0", WaveBase: "0.14.5", BuildTime: "0"})
	if want := "MoltenTerm 0.0.0, based on Wave Terminal 0.14.5\n"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	data, _ := json.Marshal(moltenVersionInfo{Version: "1.0.0-1", WaveBase: "0.14.5", BuildTime: "202610041230"})
	if string(data) != `{"version":"1.0.0-1","wavebase":"0.14.5","buildtime":"202610041230"}` {
		t.Errorf("json: %s", data)
	}
}

// The Wave base the app names must be the release UPSTREAM.md says Moltenterm is merged on.
func TestWaveBaseMatchesUpstreamFile(t *testing.T) {
	data, err := os.ReadFile("../../../UPSTREAM.md")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?s)## Current base.*?\n\| v(\d+\.\d+\.\d+)\s`).FindSubmatch(data)
	if m == nil {
		t.Fatal("no release in UPSTREAM.md's Current base table")
	}
	if string(m[1]) != wavebase.MoltentermWaveBaseVersion {
		t.Errorf("UPSTREAM.md says %s, MoltentermWaveBaseVersion %s", m[1], wavebase.MoltentermWaveBaseVersion)
	}
}

func TestMoltenVersionNeedsNoApp(t *testing.T) {
	if moltenVersionCmd.PreRunE != nil {
		t.Error("molten version must answer outside MoltenTerm, without the RPC client")
	}
	found, _, err := moltenCmd.Find([]string{"version"})
	if err != nil || found != moltenVersionCmd {
		t.Errorf("molten version routes to %v, %v", found, err)
	}
}
