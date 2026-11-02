// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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
