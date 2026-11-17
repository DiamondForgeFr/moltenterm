// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wconfig

import (
	"fmt"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// #1758: the Integration panel writes its sort and its folds as two settings, often back to back; neither may be lost.
func TestSetBaseConfigValueConcurrentWritesKeepEveryKey(t *testing.T) {
	configDir := t.TempDir()
	previous := wavebase.ConfigHome_VarCache
	wavebase.ConfigHome_VarCache = configDir
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = previous })

	const rounds = 20
	for round := 0; round < rounds; round++ {
		writes := []waveobj.MetaMapType{
			{"moltenterm:reviewssort": "merge"},
			{"moltenterm:reviewsfolds": map[string]any{"merged": false, "round": round%2 == 0}},
			{"moltenterm:view360": "always"},
			{"moltenterm:theme": "light"},
		}
		if err := WriteWaveHomeConfigFile(SettingsFile, waveobj.MetaMapType{}); err != nil {
			t.Fatalf("reset: %v", err)
		}
		var wg sync.WaitGroup
		errs := make(chan error, len(writes))
		for _, w := range writes {
			wg.Add(1)
			go func(w waveobj.MetaMapType) {
				defer wg.Done()
				if err := SetBaseConfigValue(w); err != nil {
					errs <- err
				}
			}(w)
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatalf("round %d: %v", round, err)
		}
		m, cerrs := ReadWaveHomeConfigFile(SettingsFile)
		if len(cerrs) > 0 {
			t.Fatalf("round %d read: %v", round, cerrs[0])
		}
		for _, key := range []string{"moltenterm:reviewssort", "moltenterm:reviewsfolds", "moltenterm:view360", "moltenterm:theme"} {
			if m[key] == nil {
				t.Fatalf("round %d: %s lost, file holds %s", round, key, fmt.Sprint(m))
			}
		}
	}
}

// #1763: the page sends the materials' seen times as JSON numbers (float64 once decoded); they are kept as whole ms.
func TestSetBaseConfigValueKeepsLibraryPrefs(t *testing.T) {
	configDir := t.TempDir()
	previous := wavebase.ConfigHome_VarCache
	wavebase.ConfigHome_VarCache = configDir
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = previous })

	if err := WriteWaveHomeConfigFile(SettingsFile, waveobj.MetaMapType{}); err != nil {
		t.Fatalf("reset: %v", err)
	}
	seen := map[string]any{"proj-a": float64(1793640000123), "proj-b": float64(1)}
	if err := SetBaseConfigValue(waveobj.MetaMapType{"moltenterm:materialsseen": seen, "moltenterm:settingstab": "agents"}); err != nil {
		t.Fatalf("set: %v", err)
	}
	m, cerrs := ReadWaveHomeConfigFile(SettingsFile)
	if len(cerrs) > 0 {
		t.Fatalf("read: %v", cerrs[0])
	}
	if m["moltenterm:settingstab"] != "agents" {
		t.Fatalf("settingstab: %v", m["moltenterm:settingstab"])
	}
	got, _ := m["moltenterm:materialsseen"].(map[string]any)
	if got["proj-a"] != float64(1793640000123) || got["proj-b"] != float64(1) {
		t.Fatalf("materialsseen: %s", fmt.Sprint(m["moltenterm:materialsseen"]))
	}
	if err := SetBaseConfigValue(waveobj.MetaMapType{"moltenterm:materialsseen": map[string]any{"x": "soon"}}); err == nil {
		t.Fatalf("a seen time that is not a number was accepted")
	}
}

// #2180: "Do the same in every view" stores Automatic and the number of visible panels in one write; the number is a
// string, as the choices of the settings screen are.
func TestSetBaseConfigValueStoresTheOfferAnswerForEveryView(t *testing.T) {
	configDir := t.TempDir()
	previous := wavebase.ConfigHome_VarCache
	wavebase.ConfigHome_VarCache = configDir
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = previous })

	if err := WriteWaveHomeConfigFile(SettingsFile, waveobj.MetaMapType{}); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if err := SetBaseConfigValue(waveobj.MetaMapType{"moltenterm:view360": "auto", "moltenterm:view360places": "2"}); err != nil {
		t.Fatalf("set: %v", err)
	}
	m, cerrs := ReadWaveHomeConfigFile(SettingsFile)
	if len(cerrs) > 0 {
		t.Fatalf("read: %v", cerrs[0])
	}
	if m["moltenterm:view360"] != "auto" || m["moltenterm:view360places"] != "2" {
		t.Fatalf("view360: %v, places: %v", m["moltenterm:view360"], m["moltenterm:view360places"])
	}
	if err := SetBaseConfigValue(waveobj.MetaMapType{"moltenterm:view360places": nil}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	m, _ = ReadWaveHomeConfigFile(SettingsFile)
	if _, ok := m["moltenterm:view360places"]; ok {
		t.Fatalf("the number of visible panels was not cleared: %v", m)
	}
}

func TestView360PlacesIsAStringSetting(t *testing.T) {
	ctype := getConfigKeyType("moltenterm:view360places")
	if ctype == nil || ctype.Kind().String() != "string" {
		t.Fatalf("moltenterm:view360places has type %v, want a string", ctype)
	}
}
